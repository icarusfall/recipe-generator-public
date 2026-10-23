# What's for Dinner?

A small web app that writes dinner recipes for each person in your house, using Claude.

Add the people in your household, say what each of them likes, and pick the style they want recipes written in. A beginner might want chatty, step-by-step help; a confident cook might want something short and to the point. Then:

1. Tap a name and get a handful of dinner ideas made for them.
2. Pick one, or type what you fancy ("something quick with chicken") for new ideas or a recipe straight away.
3. Change the recipe with plain words: "substitute the mushrooms, please".
4. Add recipes to the week's plan and get one combined shopping list to copy or print.

Each household runs its own copy with its own Anthropic API key, so you pay only for what your household uses.

## Deploy on Railway

You'll need a [GitHub](https://github.com) account, a [Railway](https://railway.com) account and an [Anthropic API key](https://console.anthropic.com/settings/keys).

1. **Fork this repository** on GitHub.
2. In Railway, choose **New Project → Deploy from GitHub repo** and pick your fork.
3. Open the service's **Variables** tab and add:
   - `ANTHROPIC_API_KEY`: your Anthropic key
   - `APP_PASSPHRASE`: the passphrase your household will type to get in
4. **Add a volume** so your people and recipes survive redeploys: right-click the service → **Attach volume**, mount path `/data`. The app finds it automatically.
5. Under **Settings → Networking**, click **Generate Domain**. Open it, type your passphrase and add your first person.

**Set a spending limit.** In the Anthropic Console, under Billing, set a monthly limit you're comfortable with. The app also caps itself at 100 Claude requests an hour (change this with `CLAUDE_REQUESTS_PER_HOUR`).

## Settings

| Variable | Required | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Your Anthropic API key |
| `APP_PASSPHRASE` | yes | Shared household passphrase. Changing it signs everyone out |
| `MODEL` | no | Claude model to use. Defaults to `claude-opus-5-5`; `claude-sonnet-5-5` is cheaper |
| `CLAUDE_REQUESTS_PER_HOUR` | no | Hourly cap on Claude requests for the whole household (default 100) |
| `DATA_DIR` | no | Where the database is stored. Railway volumes are detected automatically |

## Run it on your own computer

Needs [Node.js](https://nodejs.org) 22.13 or newer.

```bash
npm install
cp .env.example .env   # then fill in the two required values
npm start
```

Open http://localhost:3000. Your data is stored in `data/recipes.db`.

## How it works

- `server.js`: an Express server. It checks the passphrase, then builds the prompts from your household settings and each person's profile. It asks Claude for structured JSON, so recipes always come back in a consistent format.
- `db.js`: a single SQLite file (using Node's built-in `node:sqlite`, so there's nothing to compile) holding people, past choices, saved recipes, the weekly plan and the store cupboard.
- `public/`: plain HTML, CSS and JavaScript, with no build step.

**Allergies:** the "Never include" field is treated as a hard rule in every prompt, but AI-generated recipes can still make mistakes. Always check ingredients yourself when an allergy is involved.
