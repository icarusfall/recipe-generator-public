const express = require("express");
const Anthropic = require("@anthropic-ai/sdk").default;
const crypto = require("crypto");
const path = require("path");
const db = require("./db");

for (const name of ["ANTHROPIC_API_KEY", "APP_PASSPHRASE"]) {
  if (!process.env[name]) {
    console.error(`Missing ${name}. Set it in your hosting dashboard, or in a .env file locally (see .env.example).`);
    process.exit(1);
  }
}

const MODEL = process.env.MODEL || "claude-opus-5-5";
const CLAUDE_REQUESTS_PER_HOUR = parseInt(process.env.CLAUDE_REQUESTS_PER_HOUR, 10) || 100;
const SUGGESTION_COUNT = 6;

const client = new Anthropic();
const app = express();
app.set("trust proxy", 1); // Railway/Vercel sit behind a proxy; needed for req.ip and req.secure
app.use(express.json({ limit: "200kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/healthz", (req, res) => res.send("ok"));

// ===== Auth: one shared family passphrase, remembered in a signed cookie =====
// The signing key is derived from the passphrase, so changing the passphrase
// signs everyone out.
const SESSION_COOKIE = "session";
const SESSION_DAYS = 180;
const signingKey = crypto.createHash("sha256").update("recipe-session:" + process.env.APP_PASSPHRASE).digest();

const sign = value => crypto.createHmac("sha256", signingKey).update(value).digest("base64url");

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function readCookie(req, name) {
  const match = (req.headers.cookie || "").split(/;\s*/).find(c => c.startsWith(name + "="));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

function isSignedIn(req) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return false;
  const [issued, sig] = token.split(".");
  if (!issued || !sig || !safeEqual(sig, sign(issued))) return false;
  return Date.now() - Number(issued) < SESSION_DAYS * 86400_000;
}

const failedLogins = new Map(); // ip -> timestamps of recent failures

app.post("/api/login", (req, res) => {
  const now = Date.now();
  const recent = (failedLogins.get(req.ip) || []).filter(t => now - t < 15 * 60_000);
  if (recent.length >= 10) return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });

  const passphrase = String(req.body.passphrase || "");
  if (!safeEqual(passphrase, process.env.APP_PASSPHRASE)) {
    failedLogins.set(req.ip, [...recent, now]);
    return res.status(401).json({ error: "That's not the passphrase." });
  }

  failedLogins.delete(req.ip);
  const issued = String(now);
  res.cookie(SESSION_COOKIE, `${issued}.${sign(issued)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure,
    maxAge: SESSION_DAYS * 86400_000,
  });
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

app.use("/api", (req, res, next) => {
  if (!isSignedIn(req)) return res.status(401).json({ error: "Not signed in" });
  next();
});

// ===== Claude =====
// The whole household shares one API key, so cap how often it can be called.
const claudeCalls = [];
function claudeRateLimit(req, res, next) {
  const now = Date.now();
  while (claudeCalls.length && now - claudeCalls[0] > 3600_000) claudeCalls.shift();
  if (claudeCalls.length >= CLAUDE_REQUESTS_PER_HOUR) {
    return res.status(429).json({ error: "That's a lot of recipes for one hour! Try again a bit later." });
  }
  claudeCalls.push(now);
  next();
}

// JSON schemas for structured outputs — the API guarantees the response text
// parses and matches these, so no fence-stripping or bracket-hunting needed.
const RECIPE_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    prepTime: { type: "integer" },
    cookTime: { type: "integer" },
    servings: { type: "integer" },
    ingredients: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          quantity: { type: "string" },
          unit: { type: "string" },
          category: {
            type: "string",
            enum: ["meat", "fish", "dairy", "vegetable", "fruit", "spice", "pantry", "other"],
          },
        },
        required: ["name", "quantity", "unit", "category"],
        additionalProperties: false,
      },
    },
    method: { type: "array", items: { type: "string" } },
  },
  required: ["name", "description", "prepTime", "cookTime", "servings", "ingredients", "method"],
  additionalProperties: false,
};

const SUGGESTIONS_SCHEMA = {
  type: "object",
  properties: {
    suggestions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          emoji: { type: "string" },
          prepTime: { type: "integer" },
          cookTime: { type: "integer" },
        },
        required: ["name", "description", "emoji", "prepTime", "cookTime"],
        additionalProperties: false,
      },
    },
  },
  required: ["suggestions"],
  additionalProperties: false,
};

// One place for every Claude call: a schema-constrained JSON response.
// `fallbacks: "default"` re-runs the request on Anthropic's recommended model
// if a safety classifier declines it (rare for recipes, but cheap insurance
// against a false positive breaking the app).
async function askClaude({ prompt, schema, effort = "medium", maxTokens = 16000 }) {
  const message = await client.beta.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort, format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: prompt }],
  });

  if (message.stop_reason === "refusal") {
    throw new Error(`Request declined (${message.stop_details?.category ?? "unknown"})`);
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error("Response truncated at max_tokens");
  }
  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("No text in response");
  return JSON.parse(textBlock.text);
}

// ===== Prompt building =====
// Everything personal comes from the admin settings, so the prompts themselves
// stay generic enough for any household.
function householdContext() {
  const h = db.getHousehold();
  const lines = [`The household is in: ${h.locale}. Use ingredient names, units and quantities that make sense there.`];
  if (h.rules.trim()) {
    lines.push(`Household rules that apply to every recipe:\n${h.rules.trim()}`);
  }
  return { text: lines.join("\n\n"), servings: h.servings };
}

function personContext(person) {
  if (!person) return "";
  const lines = [`This is for ${person.name}.`];
  if (person.likes.trim()) lines.push(`What they like: ${person.likes.trim()}`);
  if (person.avoid.trim()) {
    lines.push(`Never include: ${person.avoid.trim()}\nThis is a hard rule (it may be an allergy), not a preference. Check every ingredient against it, including stocks, sauces and garnishes.`);
  }
  return lines.join("\n");
}

function styleInstruction(person) {
  const style = person?.style.trim();
  const voice = style
    ? `Write the description and method steps in the style ${person.name} asked for: "${style}".`
    : "Write the method in a clear, friendly style with a sensible level of detail.";
  return `${voice} Whatever the style, quantities, temperatures and timings must stay accurate, and every step must be safe to follow.`;
}

const RECIPE_RULES = `prepTime and cookTime are in minutes. Be realistic — include time for chopping, marinating, resting etc in prepTime.
Name ingredients the way a shop would (e.g. "chopped tomatoes", "red onion", "beef mince") and put the amount in quantity/unit rather than the name. Include realistic quantities. Keep it practical for a home kitchen.`;

// ===== Input helpers =====
const text = (v, max) => String(v ?? "").trim().slice(0, max);

function personFields(body) {
  const colour = /^#[0-9a-f]{6}$/i.test(body.colour) ? body.colour : "#4ECDC4";
  return {
    name: text(body.name, 40),
    emoji: text(body.emoji, 16) || "🍽️",
    colour,
    likes: text(body.likes, 2000),
    style: text(body.style, 1000),
    avoid: text(body.avoid, 1000),
  };
}

function isRecipe(r) {
  return r && typeof r.name === "string" && Array.isArray(r.ingredients) && Array.isArray(r.method);
}

const id = v => parseInt(v, 10);

// ===== State =====
app.get("/api/state", (req, res) => {
  res.json({
    household: db.getHousehold(),
    people: db.listPeople(),
    plan: db.listPlan(),
    cupboard: db.listCupboard(),
    model: MODEL,
  });
});

// ===== Household & people (admin) =====
app.put("/api/household", (req, res) => {
  const servings = Math.min(Math.max(id(req.body.servings) || 4, 1), 20);
  res.json(db.updateHousehold({
    rules: text(req.body.rules, 3000),
    servings,
    locale: text(req.body.locale, 100) || "UK, metric units",
  }));
});

app.post("/api/people", (req, res) => {
  const fields = personFields(req.body);
  if (!fields.name) return res.status(400).json({ error: "name required" });
  res.json(db.createPerson(fields));
});

app.put("/api/people/:id", (req, res) => {
  const fields = personFields(req.body);
  if (!fields.name) return res.status(400).json({ error: "name required" });
  if (!db.getPerson(id(req.params.id))) return res.status(404).json({ error: "not found" });
  res.json(db.updatePerson(id(req.params.id), fields));
});

app.delete("/api/people/:id", (req, res) => {
  db.deletePerson(id(req.params.id));
  res.json({ ok: true });
});

app.delete("/api/people/:id/history", (req, res) => {
  db.clearHistory(id(req.params.id));
  res.json({ ok: true });
});

// ===== Suggestions =====
app.post("/api/people/:id/suggestions", claudeRateLimit, async (req, res) => {
  const person = db.getPerson(id(req.params.id));
  if (!person) return res.status(404).json({ error: "not found" });

  const mood = text(req.body.mood, 300);
  const history = db.getHistory(person.id);
  const historyText = history.length
    ? `Recently chosen recipes (most recent last):\n${history.map(h => `- ${h.name}`).join("\n")}`
    : "No recipe history yet.";
  const moodText = mood
    ? `They're currently in the mood for: "${mood}". Weight suggestions towards this but still include some variety.`
    : "";

  try {
    const result = await askClaude({
      schema: SUGGESTIONS_SCHEMA,
      prompt: `You're suggesting dinner recipes for one member of a household.

${personContext(person)}

${householdContext().text}

${historyText}
${moodText}

Generate exactly ${SUGGESTION_COUNT} recipe suggestions. Rules:
- Tailor to their preferences but ensure variety
- At least one should gently push beyond their usual choices while still appealing to them
- Don't repeat any recipes from their recent history
- Every suggestion must follow the household rules and must not contain anything they never eat
- Make each description an appetising one-liner with a fitting emoji, written in a tone that suits this style: "${person.style || "friendly"}"

prepTime and cookTime are in minutes. Be realistic.`,
    });
    res.json(result.suggestions);
  } catch (err) {
    console.error("Claude suggest error:", err.message);
    res.status(500).json({ error: "Failed to generate suggestions" });
  }
});

// ===== Recipes =====
app.post("/api/recipes/generate", claudeRateLimit, async (req, res) => {
  const description = text(req.body.description, 500);
  if (!description) return res.status(400).json({ error: "description required" });
  const person = req.body.personId ? db.getPerson(id(req.body.personId)) : null;
  const household = householdContext();

  try {
    const recipe = await askClaude({
      schema: RECIPE_SCHEMA,
      prompt: `Generate a recipe based on this description: "${description}"

${personContext(person)}

${household.text}

Make it serve ${household.servings} unless the description asks otherwise.
${styleInstruction(person)}

${RECIPE_RULES}`,
    });
    if (person) db.recordChoice(person.id, recipe.name);
    const savedId = db.saveRecipe(person?.id ?? null, recipe);
    res.json({ savedId, recipe });
  } catch (err) {
    console.error("Claude generate error:", err.message);
    res.status(500).json({ error: "Failed to generate recipe" });
  }
});

app.post("/api/recipes/tweak", claudeRateLimit, async (req, res) => {
  const { recipe } = req.body;
  const instruction = text(req.body.instruction, 500);
  if (!isRecipe(recipe) || !instruction) return res.status(400).json({ error: "recipe and instruction required" });
  const person = req.body.personId ? db.getPerson(id(req.body.personId)) : null;

  try {
    const updated = await askClaude({
      schema: RECIPE_SCHEMA,
      prompt: `Here is an existing recipe as JSON:
${JSON.stringify(recipe)}

The cook wants this change: "${instruction}"

Apply the change. Update the ingredients list and method steps as needed and leave everything else as it was.

${personContext(person)}

${householdContext().text}

${styleInstruction(person)}
The updated recipe must still follow the household rules and must not contain anything they never eat, even if the change asks for it — in that case use the closest safe alternative and say so in the description.

${RECIPE_RULES}`,
    });
    // Tweaks replace the saved copy, so the saved list doesn't fill with near-duplicates
    const savedId = req.body.savedId && db.updateSaved(id(req.body.savedId), updated)
      ? id(req.body.savedId)
      : db.saveRecipe(person?.id ?? null, updated);
    res.json({ savedId, recipe: updated });
  } catch (err) {
    console.error("Claude tweak error:", err.message);
    res.status(500).json({ error: "Failed to tweak recipe" });
  }
});

// ===== Saved recipes =====
app.get("/api/saved", (req, res) => res.json(db.listSaved()));

app.delete("/api/saved/:id", (req, res) => {
  db.deleteSaved(id(req.params.id));
  res.json({ ok: true });
});

// ===== Weekly plan =====
app.post("/api/plan", (req, res) => {
  if (!isRecipe(req.body.recipe)) return res.status(400).json({ error: "recipe required" });
  db.addToPlan(req.body.personId ? id(req.body.personId) : null, req.body.recipe);
  res.json(db.listPlan());
});

app.delete("/api/plan/:id", (req, res) => {
  db.removeFromPlan(id(req.params.id));
  res.json(db.listPlan());
});

app.delete("/api/plan", (req, res) => {
  db.clearPlan();
  res.json([]);
});

// ===== Cupboard =====
app.post("/api/cupboard", (req, res) => {
  const name = text(req.body.name, 100).toLowerCase();
  if (name) db.addToCupboard(name);
  res.json(db.listCupboard());
});

app.delete("/api/cupboard/:name", (req, res) => {
  db.removeFromCupboard(req.params.name.toLowerCase());
  res.json(db.listCupboard());
});

app.delete("/api/cupboard", (req, res) => {
  db.clearCupboard();
  res.json([]);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT} (model: ${MODEL})`));
