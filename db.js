// All persistent state lives in one SQLite file. Node's built-in driver keeps
// the app free of native dependencies, so forks deploy without a build step.
const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

if (process.env.RAILWAY_ENVIRONMENT && !process.env.RAILWAY_VOLUME_MOUNT_PATH && !process.env.DATA_DIR) {
  console.warn("WARNING: no Railway volume attached — profiles and recipes will be lost on every redeploy. See README.");
}

const db = new DatabaseSync(path.join(DATA_DIR, "recipes.db"));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS household (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    rules TEXT NOT NULL DEFAULT '',
    servings INTEGER NOT NULL DEFAULT 4,
    locale TEXT NOT NULL DEFAULT 'UK, metric units'
  );
  INSERT OR IGNORE INTO household (id) VALUES (1);

  CREATE TABLE IF NOT EXISTS people (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    emoji TEXT NOT NULL DEFAULT '🍽️',
    colour TEXT NOT NULL DEFAULT '#4ECDC4',
    likes TEXT NOT NULL DEFAULT '',
    style TEXT NOT NULL DEFAULT '',
    avoid TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    recipe_name TEXT NOT NULL,
    date TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS saved (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
    recipe TEXT NOT NULL,
    date TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS plan (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
    recipe TEXT NOT NULL,
    date TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cupboard (
    name TEXT PRIMARY KEY
  );
`);

const today = () => new Date().toISOString().split("T")[0];

const HISTORY_LIMIT = 30;
const SAVED_LIMIT = 50;

// ===== Household =====
function getHousehold() {
  return db.prepare("SELECT rules, servings, locale FROM household WHERE id = 1").get();
}

function updateHousehold({ rules, servings, locale }) {
  db.prepare("UPDATE household SET rules = ?, servings = ?, locale = ? WHERE id = 1")
    .run(rules, servings, locale);
  return getHousehold();
}

// ===== People =====
function listPeople() {
  const people = db.prepare("SELECT * FROM people ORDER BY id").all();
  const counts = db.prepare("SELECT person_id, COUNT(*) AS n FROM history GROUP BY person_id").all();
  const byId = Object.fromEntries(counts.map(c => [c.person_id, c.n]));
  return people.map(p => ({ ...p, historyCount: byId[p.id] || 0 }));
}

function getPerson(id) {
  return db.prepare("SELECT * FROM people WHERE id = ?").get(id);
}

function createPerson(p) {
  const { lastInsertRowid } = db.prepare(
    "INSERT INTO people (name, emoji, colour, likes, style, avoid) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(p.name, p.emoji, p.colour, p.likes, p.style, p.avoid);
  return getPerson(lastInsertRowid);
}

function updatePerson(id, p) {
  db.prepare(
    "UPDATE people SET name = ?, emoji = ?, colour = ?, likes = ?, style = ?, avoid = ? WHERE id = ?"
  ).run(p.name, p.emoji, p.colour, p.likes, p.style, p.avoid, id);
  return getPerson(id);
}

function deletePerson(id) {
  db.prepare("DELETE FROM people WHERE id = ?").run(id);
}

// ===== History =====
function getHistory(personId, limit = 10) {
  return db.prepare(
    "SELECT recipe_name AS name, date FROM history WHERE person_id = ? ORDER BY id DESC LIMIT ?"
  ).all(personId, limit).reverse();
}

function recordChoice(personId, recipeName) {
  db.prepare("INSERT INTO history (person_id, recipe_name, date) VALUES (?, ?, ?)")
    .run(personId, recipeName, today());
  db.prepare(`DELETE FROM history WHERE person_id = ? AND id NOT IN
    (SELECT id FROM history WHERE person_id = ? ORDER BY id DESC LIMIT ?)`)
    .run(personId, personId, HISTORY_LIMIT);
}

function clearHistory(personId) {
  db.prepare("DELETE FROM history WHERE person_id = ?").run(personId);
}

// ===== Saved recipes (every generated recipe, newest kept) =====
const rowToEntry = r => ({ id: r.id, personId: r.person_id, recipe: JSON.parse(r.recipe), date: r.date });

function listSaved() {
  return db.prepare("SELECT * FROM saved ORDER BY id DESC").all().map(rowToEntry);
}

function saveRecipe(personId, recipe) {
  const { lastInsertRowid } = db.prepare("INSERT INTO saved (person_id, recipe, date) VALUES (?, ?, ?)")
    .run(personId, JSON.stringify(recipe), today());
  db.prepare("DELETE FROM saved WHERE id NOT IN (SELECT id FROM saved ORDER BY id DESC LIMIT ?)")
    .run(SAVED_LIMIT);
  return Number(lastInsertRowid);
}

function updateSaved(id, recipe) {
  return db.prepare("UPDATE saved SET recipe = ? WHERE id = ?").run(JSON.stringify(recipe), id).changes > 0;
}

function deleteSaved(id) {
  db.prepare("DELETE FROM saved WHERE id = ?").run(id);
}

// ===== Weekly plan =====
function listPlan() {
  return db.prepare("SELECT * FROM plan ORDER BY id").all().map(rowToEntry);
}

function addToPlan(personId, recipe) {
  db.prepare("INSERT INTO plan (person_id, recipe, date) VALUES (?, ?, ?)")
    .run(personId, JSON.stringify(recipe), today());
}

function removeFromPlan(id) {
  db.prepare("DELETE FROM plan WHERE id = ?").run(id);
}

function clearPlan() {
  db.prepare("DELETE FROM plan").run();
}

// ===== Cupboard =====
function listCupboard() {
  return db.prepare("SELECT name FROM cupboard ORDER BY name").all().map(r => r.name);
}

function addToCupboard(name) {
  db.prepare("INSERT OR IGNORE INTO cupboard (name) VALUES (?)").run(name);
}

function removeFromCupboard(name) {
  db.prepare("DELETE FROM cupboard WHERE name = ?").run(name);
}

function clearCupboard() {
  db.prepare("DELETE FROM cupboard").run();
}

module.exports = {
  getHousehold, updateHousehold,
  listPeople, getPerson, createPerson, updatePerson, deletePerson,
  getHistory, recordChoice, clearHistory,
  listSaved, saveRecipe, updateSaved, deleteSaved,
  listPlan, addToPlan, removeFromPlan, clearPlan,
  listCupboard, addToCupboard, removeFromCupboard, clearCupboard,
};
