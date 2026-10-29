// Scoreboard public API: plain Node ESM, with no Electron or third-party imports.
export { normalizeState } from './state.js';
export { listTemplates, createTemplate, deleteTemplate, addAsset, snapshot, restore, refreshBuiltinTemplate } from './templates.js';
export { createScoreboardServer } from './server.js';
export { runScoreboardAgent, AGENT_PRESETS } from './agent.js';
