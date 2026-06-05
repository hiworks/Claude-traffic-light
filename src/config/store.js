// Config Store — Simple JSON file-based configuration
//
// Stores user preferences in %APPDATA%/claude-traffic-light/config.json

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const CONFIG_DIR = () => {
  const appData = app.getPath('appData');
  return path.join(appData, 'claude-traffic-light');
};

const CONFIG_FILE = () => path.join(CONFIG_DIR(), 'config.json');

const DEFAULTS = {
  windowBounds: null,
  sizeMode: 'normal',
  opacity: 1.0,
  alwaysOnTop: true,
  autoStart: false,
  followTerminal: false,
};

function createStore() {
  let data = { ...DEFAULTS };

  function load() {
    try {
      const dir = CONFIG_DIR();
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const file = CONFIG_FILE();
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, 'utf-8');
        const parsed = JSON.parse(raw);
        data = { ...DEFAULTS, ...parsed };
      }
    } catch {
      // Use defaults if config is corrupted
      data = { ...DEFAULTS };
    }
  }

  function save() {
    try {
      const dir = CONFIG_DIR();
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(CONFIG_FILE(), JSON.stringify(data, null, 2), 'utf-8');
    } catch {
      // Silently fail — config is nice-to-have, not critical
    }
  }

  function get(key) {
    return data[key];
  }

  function set(key, value) {
    data[key] = value;
    save();
  }

  // Load on creation
  load();

  return { get, set };
}

module.exports = { createStore };
