let state = { household: null, people: [], plan: [], cupboard: [] };
let currentRecipe = null;
let currentSavedId = null;
let activePersonId = null;

// ===== Helpers =====
// Names, preferences and recipe text all end up in innerHTML, so escape them.
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && path !== "/api/login") {
    showLogin();
    throw new Error("Not signed in");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong");
  return data;
}

const getPerson = personId => state.people.find(p => p.id === personId) || null;

function personBadge(personId) {
  const p = getPerson(personId);
  return p ? `<span class="person-badge" style="background:${esc(p.colour)}">${esc(p.emoji)} ${esc(p.name)}</span>` : "";
}

const CATEGORY_EMOJI = {
  meat: "🥩", fish: "🐟", dairy: "🧀", vegetable: "🥬", fruit: "🍋",
  spice: "🌶️", pantry: "🫙", other: "🛒",
};

function formatTime(mins) {
  if (!mins) return null;
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function timingBadge(recipe) {
  const total = (recipe.prepTime || 0) + (recipe.cookTime || 0);
  return total ? `<span class="timing-badge">⏱️ ${formatTime(total)}</span>` : "";
}

function timingDetail(recipe) {
  const prep = recipe.prepTime;
  const cook = recipe.cookTime;
  if (!prep && !cook) return "";
  const parts = [];
  if (prep) parts.push(`Prep: ${formatTime(prep)}`);
  if (cook) parts.push(`Cook: ${formatTime(cook)}`);
  parts.push(`Total: ${formatTime((prep || 0) + (cook || 0))}`);
  return `<div class="timing-detail">⏱️ ${parts.join(" · ")}</div>`;
}

function recipeEmoji(recipe) {
  // Pick an emoji based on the main protein/theme
  const names = recipe.ingredients.map(i => i.name.toLowerCase()).join(" ");
  if (/chicken/.test(names)) return "🍗";
  if (/beef|steak/.test(names)) return "🥩";
  if (/lamb/.test(names)) return "🐑";
  if (/pork|sausage/.test(names)) return "🐷";
  if (/salmon|fish|prawn|haddock|cod/.test(names)) return "🐟";
  if (/pasta|spaghetti|penne/.test(names)) return "🍝";
  if (/rice/.test(names)) return "🍚";
  if (/tofu|chickpea|lentil|bean/.test(names)) return "🥗";
  return "🍽️";
}

function flash(el, message, ms = 2000) {
  el.textContent = message;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), ms);
}

// ===== Navigation =====
const PAGE_SECTIONS = ["login-section", "profile-section", "suggestions-section", "saved-section", "admin-section"];
const HOME_EXTRAS = ["weekly-order-section", "cupboard-section"];
const RECIPE_SECTIONS = ["ingredient-section", "method-section"];

function showSection(id) {
  [...PAGE_SECTIONS, ...RECIPE_SECTIONS].forEach(s => document.getElementById(s).classList.add("hidden"));
  document.getElementById(id).classList.remove("hidden");
  const signedIn = id !== "login-section";
  HOME_EXTRAS.forEach(s => document.getElementById(s).classList.toggle("hidden", !signedIn));
}

function showHome() {
  activePersonId = null;
  showSection("profile-section");
  renderPeople();
}

function showLogin() {
  showSection("login-section");
  document.getElementById("passphrase-input").focus();
}

// ===== Sign in =====
document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("passphrase-input");
  const status = document.getElementById("login-status");
  status.classList.add("hidden");
  try {
    await api("/api/login", { method: "POST", body: { passphrase: input.value } });
    input.value = "";
    await loadState();
    showHome();
  } catch (err) {
    status.textContent = err.message;
    status.classList.remove("hidden");
  }
});

document.getElementById("logout-btn").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  showLogin();
});

// ===== Person Picker =====
function renderPeople() {
  const grid = document.getElementById("profile-grid");
  document.getElementById("no-people").classList.toggle("hidden", state.people.length > 0);
  grid.innerHTML = state.people.map(p => `
    <button class="profile-btn" data-id="${p.id}" style="background: ${esc(p.colour)}">
      <span class="profile-emoji">${esc(p.emoji)}</span>
      ${esc(p.name)}
    </button>
  `).join("");

  grid.querySelectorAll(".profile-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      activePersonId = Number(btn.dataset.id);
      openSuggestions(activePersonId);
    });
  });
}

// ===== Suggestions =====
function setLoading(message) {
  const loading = document.getElementById("suggestions-loading");
  loading.classList.toggle("hidden", !message);
  if (message) loading.querySelector("span").textContent = message;
}

async function openSuggestions(personId, mood) {
  const person = getPerson(personId);
  document.getElementById("suggestions-title").textContent = `What do you fancy, ${person.name}?`;
  showSection("suggestions-section");

  const grid = document.getElementById("suggestions-grid");
  grid.innerHTML = "";
  setLoading("Thinking up some ideas...");

  try {
    const suggestions = await api(`/api/people/${personId}/suggestions`, { method: "POST", body: { mood: mood || "" } });
    renderSuggestions(suggestions, person);
  } catch (err) {
    grid.innerHTML = `<p class="error-text">${esc(err.message)}</p>`;
  } finally {
    setLoading(null);
  }
}

function renderSuggestions(suggestions, person) {
  const grid = document.getElementById("suggestions-grid");
  grid.innerHTML = suggestions.map((s, i) => `
    <div class="suggestion-card" data-index="${i}" style="border-left: 5px solid ${esc(person.colour)}">
      <span class="card-emoji">${esc(s.emoji || "🍲")}</span>
      <h3>${esc(s.name)}</h3>
      <p>${esc(s.description)}</p>
      ${timingBadge(s)}
    </div>
  `).join("");

  grid.querySelectorAll(".suggestion-card").forEach(card => {
    card.addEventListener("click", () => {
      const s = suggestions[Number(card.dataset.index)];
      generateRecipe(`${s.name} - ${s.description}`, `Generating ${s.name}...`);
    });
  });
}

async function generateRecipe(description, loadingMessage) {
  setLoading(loadingMessage);
  try {
    const { savedId, recipe } = await api("/api/recipes/generate", {
      method: "POST",
      body: { description, personId: activePersonId },
    });
    showRecipe(recipe, savedId);
  } catch (err) {
    alert(err.message);
  } finally {
    setLoading(null);
  }
}

document.getElementById("show-more-btn").addEventListener("click", () => {
  if (!activePersonId) return;
  openSuggestions(activePersonId, document.getElementById("mood-input").value.trim());
});

document.getElementById("make-this-btn").addEventListener("click", () => {
  const input = document.getElementById("mood-input");
  const description = input.value.trim();
  if (!description) return input.focus();
  generateRecipe(description, "Writing your recipe...");
});

document.getElementById("mood-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("show-more-btn").click();
});

document.getElementById("back-to-profiles").addEventListener("click", showHome);

// ===== Recipe View =====
function showRecipe(recipe, savedId = null) {
  currentRecipe = recipe;
  currentSavedId = savedId;

  document.getElementById("recipe-emoji").textContent = recipeEmoji(recipe);
  document.getElementById("selected-recipe-name").textContent = recipe.name;
  document.getElementById("selected-description").textContent = recipe.description || "";
  document.getElementById("selected-servings").textContent = recipe.servings;
  document.getElementById("selected-timing").innerHTML = timingDetail(recipe);

  const list = document.getElementById("ingredient-list");
  list.innerHTML = recipe.ingredients.map((ing, i) => {
    const checked = !state.cupboard.includes(ing.name.toLowerCase().trim());
    const qtyStr = [ing.quantity, ing.unit].filter(Boolean).join(" ");
    return `
      <label class="ingredient-row ${checked ? "" : "unchecked"}">
        <input type="checkbox" ${checked ? "checked" : ""} data-index="${i}">
        <div class="ingredient-info">
          <span class="ingredient-name">${esc(ing.name)}</span>
          <span class="ingredient-qty">${esc(qtyStr)}</span>
        </div>
        <span class="category-tag">${CATEGORY_EMOJI[ing.category] || "🛒"} ${esc(ing.category)}</span>
      </label>
    `;
  }).join("");

  list.querySelectorAll("input[type=checkbox]").forEach(cb => {
    cb.addEventListener("change", async () => {
      const name = recipe.ingredients[Number(cb.dataset.index)].name.toLowerCase().trim();
      cb.closest(".ingredient-row").classList.toggle("unchecked", !cb.checked);
      state.cupboard = cb.checked
        ? await api(`/api/cupboard/${encodeURIComponent(name)}`, { method: "DELETE" })
        : await api("/api/cupboard", { method: "POST", body: { name } });
      renderCupboard();
    });
  });

  const methodList = document.getElementById("method-list");
  methodList.innerHTML = recipe.method.map(s => `<li>${esc(s)}</li>`).join("");
  document.querySelector(".tweak-form").classList.toggle("hidden", recipe.isShoppingList === true);
  document.getElementById("add-to-weekly-btn").classList.toggle("hidden", recipe.isShoppingList === true);

  RECIPE_SECTIONS.forEach(s => document.getElementById(s).classList.remove("hidden"));
  document.getElementById("ingredient-section").scrollIntoView({ behavior: "smooth" });
}

// ===== Copy shopping list =====
document.getElementById("copy-list-btn").addEventListener("click", async () => {
  if (!currentRecipe) return;
  const checked = [...document.querySelectorAll("#ingredient-list input[type=checkbox]:checked")]
    .map(cb => currentRecipe.ingredients[Number(cb.dataset.index)]);
  const textList = checked
    .map(ing => `- ${ing.name}${ing.quantity ? ` (${[ing.quantity, ing.unit].filter(Boolean).join(" ")})` : ""}`)
    .join("\n");
  const btn = document.getElementById("copy-list-btn");
  try {
    await navigator.clipboard.writeText(`${currentRecipe.name}\n${textList}`);
    btn.textContent = "Copied!";
  } catch {
    btn.textContent = "Couldn't copy — try printing instead";
  }
  setTimeout(() => { btn.textContent = "📋 Copy shopping list"; }, 1800);
});

// ===== Tweak Recipe =====
document.getElementById("tweak-btn").addEventListener("click", async () => {
  const input = document.getElementById("tweak-input");
  const instruction = input.value.trim();
  if (!instruction || !currentRecipe) return;

  const btn = document.getElementById("tweak-btn");
  const status = document.getElementById("tweak-status");
  btn.disabled = true;
  status.classList.remove("hidden", "error");
  status.textContent = "Updating recipe...";

  try {
    const { savedId, recipe } = await api("/api/recipes/tweak", {
      method: "POST",
      body: { recipe: currentRecipe, instruction, personId: activePersonId, savedId: currentSavedId },
    });
    showRecipe(recipe, savedId);
    status.textContent = "Recipe updated!";
    input.value = "";
  } catch (err) {
    status.classList.add("error");
    status.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("tweak-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("tweak-btn").click();
});

// ===== Weekly Plan =====
function renderWeeklyPlan() {
  const plan = state.plan;
  const list = document.getElementById("weekly-order-list");
  document.getElementById("no-orders").classList.toggle("hidden", plan.length > 0);
  document.getElementById("weekly-order-actions").classList.toggle("hidden", plan.length === 0);

  list.innerHTML = plan.map(entry => `
    <div class="weekly-order-item">
      <div class="weekly-order-info">
        <span class="weekly-order-emoji">${recipeEmoji(entry.recipe)}</span>
        <div>
          <strong>${esc(entry.recipe.name)}</strong>
          <span class="weekly-order-meta">${personBadge(entry.personId)} ${esc(entry.date)}</span>
        </div>
      </div>
      <div class="weekly-order-actions-row">
        <button class="weekly-view-btn" data-id="${entry.id}">View</button>
        <button class="weekly-remove-btn" data-id="${entry.id}" title="Remove">&times;</button>
      </div>
    </div>
  `).join("");

  list.querySelectorAll(".weekly-view-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const entry = state.plan.find(e => e.id === Number(btn.dataset.id));
      activePersonId = entry.personId;
      showRecipe(entry.recipe);
    });
  });

  list.querySelectorAll(".weekly-remove-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      state.plan = await api(`/api/plan/${btn.dataset.id}`, { method: "DELETE" });
      renderWeeklyPlan();
    });
  });
}

document.getElementById("add-to-weekly-btn").addEventListener("click", async () => {
  if (!currentRecipe) return;
  const btn = document.getElementById("add-to-weekly-btn");
  btn.disabled = true;
  state.plan = await api("/api/plan", { method: "POST", body: { recipe: currentRecipe, personId: activePersonId } });
  renderWeeklyPlan();
  btn.textContent = "Added!";
  setTimeout(() => { btn.textContent = "+ This week"; btn.disabled = false; }, 1500);
});

document.getElementById("clear-weekly-order").addEventListener("click", async () => {
  if (!confirm("Clear this week's plan?")) return;
  state.plan = await api("/api/plan", { method: "DELETE" });
  renderWeeklyPlan();
});

document.getElementById("view-weekly-shopping-btn").addEventListener("click", () => {
  if (state.plan.length === 0) return;

  // Combine ingredients across all planned recipes, adding quantities where units match
  const combined = {};
  state.plan.forEach(entry => {
    entry.recipe.ingredients.forEach(ing => {
      const key = ing.name.toLowerCase().trim();
      if (combined[key]) {
        const existingQty = parseFloat(combined[key].quantity);
        const newQty = parseFloat(ing.quantity);
        if (!isNaN(existingQty) && !isNaN(newQty) && combined[key].unit === ing.unit) {
          combined[key].quantity = String(existingQty + newQty);
        }
      } else {
        combined[key] = { ...ing };
      }
    });
  });

  const names = state.plan.map(e => e.recipe.name);
  activePersonId = null;
  showRecipe({
    isShoppingList: true,
    name: "This Week's Shopping List",
    description: names.join(" + "),
    servings: state.plan.reduce((sum, e) => sum + (e.recipe.servings || 0), 0),
    ingredients: Object.values(combined),
    method: [`A combined shopping list for ${names.length} recipe(s): ${names.join(", ")}.`],
  });
});

// ===== Cupboard =====
function renderCupboard() {
  const container = document.getElementById("cupboard-items");
  if (state.cupboard.length === 0) {
    container.innerHTML = '<span class="muted small-text">Nothing yet</span>';
    return;
  }
  container.innerHTML = state.cupboard.map(name => `
    <span class="cupboard-tag">
      ${esc(name)}
      <button data-name="${esc(name)}" title="Remove">&times;</button>
    </span>
  `).join("");

  container.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", async () => {
      state.cupboard = await api(`/api/cupboard/${encodeURIComponent(btn.dataset.name)}`, { method: "DELETE" });
      renderCupboard();
      if (currentRecipe) showRecipe(currentRecipe, currentSavedId);
    });
  });
}

document.getElementById("clear-cupboard").addEventListener("click", async () => {
  state.cupboard = await api("/api/cupboard", { method: "DELETE" });
  renderCupboard();
  if (currentRecipe) showRecipe(currentRecipe, currentSavedId);
});

// ===== Saved Recipes =====
document.getElementById("saved-recipes-btn").addEventListener("click", () => {
  showSection("saved-section");
  renderSavedRecipes();
});

document.getElementById("back-from-saved").addEventListener("click", showHome);

async function renderSavedRecipes() {
  const grid = document.getElementById("saved-grid");
  grid.innerHTML = '<div class="loader"></div>';
  const saved = await api("/api/saved");
  document.getElementById("no-saved").classList.toggle("hidden", saved.length > 0);

  grid.innerHTML = saved.map(entry => `
    <div class="recipe-card saved-card" data-id="${entry.id}">
      <button class="delete-recipe" data-id="${entry.id}" title="Delete">&times;</button>
      <h3>${recipeEmoji(entry.recipe)} ${esc(entry.recipe.name)}</h3>
      <p>${esc(entry.recipe.description)}</p>
      <div class="saved-meta">
        ${timingBadge(entry.recipe)}
        ${personBadge(entry.personId)}
        <span class="saved-date">${esc(entry.date)}</span>
      </div>
    </div>
  `).join("");

  grid.querySelectorAll(".saved-card").forEach(card => {
    card.addEventListener("click", (e) => {
      if (e.target.classList.contains("delete-recipe")) return;
      const entry = saved.find(s => s.id === Number(card.dataset.id));
      activePersonId = entry.personId;
      showRecipe(entry.recipe, entry.id);
    });
  });

  grid.querySelectorAll(".delete-recipe").forEach(btn => {
    btn.addEventListener("click", async () => {
      await api(`/api/saved/${btn.dataset.id}`, { method: "DELETE" });
      renderSavedRecipes();
    });
  });
}

// ===== Print Recipe =====
document.getElementById("print-recipe-btn").addEventListener("click", () => {
  if (!currentRecipe) return;
  const r = currentRecipe;
  const person = getPerson(activePersonId);
  const personLine = person ? `<p class="print-person">${esc(person.emoji)} Made for ${esc(person.name)}</p>` : "";

  const ingredients = r.ingredients.map(ing => {
    const qty = [ing.quantity, ing.unit].filter(Boolean).join(" ");
    return `<li>${CATEGORY_EMOJI[ing.category] || ""} <strong>${esc(ing.name)}</strong>${qty ? ` — ${esc(qty)}` : ""}</li>`;
  }).join("");
  const method = r.method.map(s => `<li>${esc(s)}</li>`).join("");
  const timing = [
    r.prepTime && `Prep: ${formatTime(r.prepTime)}`,
    r.cookTime && `Cook: ${formatTime(r.cookTime)}`,
  ].filter(Boolean).join(" · ");

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${esc(r.name)}</title>
<style>
  body { font-family: Georgia, serif; max-width: 700px; margin: 40px auto; padding: 20px; color: #333; }
  h1 { font-size: 2rem; margin-bottom: 4px; }
  .desc { color: #666; font-style: italic; margin-bottom: 20px; }
  .print-person { font-size: 1.1rem; margin-bottom: 16px; }
  h2 { font-size: 1.3rem; margin-top: 24px; border-bottom: 2px solid #eee; padding-bottom: 6px; }
  ul, ol { padding-left: 24px; }
  li { margin-bottom: 8px; line-height: 1.5; }
  .servings { color: #888; font-size: 0.9rem; }
  @media print { body { margin: 0; } }
</style>
</head><body>
  <h1>${recipeEmoji(r)} ${esc(r.name)}</h1>
  <p class="desc">${esc(r.description)}</p>
  ${personLine}
  <p class="servings">Serves ${esc(r.servings)}${timing ? ` · ⏱️ ${timing}` : ""}</p>
  <h2>🛒 Ingredients</h2>
  <ul>${ingredients}</ul>
  <h2>👨‍🍳 Method</h2>
  <ol>${method}</ol>
</body></html>`;

  const win = window.open("", "_blank");
  win.document.write(html);
  win.document.close();
  win.focus();
  win.print();
});

// ===== People & Settings =====
function openAdmin() {
  showSection("admin-section");
  renderHouseholdForm();
  renderPersonForms();
}

document.getElementById("admin-btn").addEventListener("click", openAdmin);
document.getElementById("first-person-btn").addEventListener("click", () => {
  openAdmin();
  addBlankPersonForm();
});
document.getElementById("back-from-admin").addEventListener("click", showHome);

function renderHouseholdForm() {
  const h = state.household;
  document.getElementById("household-locale").value = h.locale;
  document.getElementById("household-servings").value = h.servings;
  document.getElementById("household-rules").value = h.rules;
}

document.getElementById("save-household-btn").addEventListener("click", async (e) => {
  state.household = await api("/api/household", {
    method: "PUT",
    body: {
      locale: document.getElementById("household-locale").value,
      servings: document.getElementById("household-servings").value,
      rules: document.getElementById("household-rules").value,
    },
  });
  flash(e.target.nextElementSibling, "Saved!");
});

const COLOURS = ["#FF6B35", "#4ECDC4", "#FF6B6B", "#7c4dff", "#4a90d9", "#f4b400", "#43a047", "#ec407a"];

function personFormHtml(p) {
  const key = p.id ?? "new";
  return `
    <div class="edit-card person-form" data-id="${key}" style="border-left: 5px solid ${esc(p.colour)}">
      <div class="person-form-top">
        <div>
          <label>Name</label>
          <input type="text" class="field" data-field="name" value="${esc(p.name)}" maxlength="40" placeholder="e.g. Sam">
        </div>
        <div>
          <label>Emoji</label>
          <input type="text" class="field narrow" data-field="emoji" value="${esc(p.emoji)}" maxlength="16">
        </div>
        <div>
          <label>Colour</label>
          <input type="color" class="colour-field" data-field="colour" value="${esc(p.colour)}">
        </div>
      </div>
      <label>Food they like</label>
      <textarea class="field" data-field="likes" rows="3" placeholder="e.g. Loves spicy food, curries and anything Mexican. Not keen on fish.">${esc(p.likes)}</textarea>
      <label>Recipe style</label>
      <textarea class="field" data-field="style" rows="2" placeholder="e.g. Chatty, detailed steps for a beginner — or — Formal and minimal, I know what I'm doing">${esc(p.style)}</textarea>
      <label>Never include (allergies &amp; hard no's)</label>
      <input type="text" class="field" data-field="avoid" value="${esc(p.avoid)}" placeholder="e.g. peanuts, shellfish">
      <div class="edit-card-actions">
        <button class="primary-btn small save-person-btn">Save</button>
        ${p.id ? `<button class="secondary-btn small delete-person-btn">Remove</button>` : ""}
        ${p.historyCount ? `<button class="link-btn inline clear-history-btn">Forget ${p.historyCount} past choice${p.historyCount === 1 ? "" : "s"}</button>` : ""}
        <span class="save-note hidden"></span>
      </div>
    </div>
  `;
}

function renderPersonForms() {
  const container = document.getElementById("person-forms");
  container.innerHTML = state.people.map(personFormHtml).join("");
  container.querySelectorAll(".person-form").forEach(wirePersonForm);
}

function addBlankPersonForm() {
  const container = document.getElementById("person-forms");
  if (container.querySelector('[data-id="new"]')) return;
  const colour = COLOURS[state.people.length % COLOURS.length];
  container.insertAdjacentHTML("beforeend", personFormHtml({ name: "", emoji: "🙂", colour, likes: "", style: "", avoid: "" }));
  const form = container.lastElementChild;
  wirePersonForm(form);
  form.querySelector('[data-field="name"]').focus();
}

document.getElementById("add-person-btn").addEventListener("click", addBlankPersonForm);

function wirePersonForm(form) {
  const personId = form.dataset.id === "new" ? null : Number(form.dataset.id);
  const note = form.querySelector(".save-note");

  form.querySelector('[data-field="colour"]').addEventListener("input", (e) => {
    form.style.borderLeftColor = e.target.value;
  });

  form.querySelector(".save-person-btn").addEventListener("click", async () => {
    const body = {};
    form.querySelectorAll("[data-field]").forEach(el => { body[el.dataset.field] = el.value; });
    if (!body.name.trim()) return flash(note, "Give them a name first");
    try {
      const saved = personId
        ? await api(`/api/people/${personId}`, { method: "PUT", body })
        : await api("/api/people", { method: "POST", body });
      await loadState();
      renderPersonForms();
      flash(document.querySelector(`.person-form[data-id="${saved.id}"] .save-note`), "Saved!");
    } catch (err) {
      flash(note, err.message);
    }
  });

  form.querySelector(".delete-person-btn")?.addEventListener("click", async () => {
    const name = form.querySelector('[data-field="name"]').value;
    if (!confirm(`Remove ${name}? Their past choices will be forgotten.`)) return;
    await api(`/api/people/${personId}`, { method: "DELETE" });
    await loadState();
    renderPersonForms();
  });

  form.querySelector(".clear-history-btn")?.addEventListener("click", async () => {
    await api(`/api/people/${personId}/history`, { method: "DELETE" });
    await loadState();
    renderPersonForms();
  });
}

// ===== Init =====
async function loadState() {
  state = await api("/api/state");
  renderPeople();
  renderWeeklyPlan();
  renderCupboard();
}

loadState().then(showHome).catch(() => {});
