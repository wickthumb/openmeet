// Independent protocol implementations, kept separate from the default meet parser.
import framing from './protocol-core/camera-link/src/index.cjs';
import session from './protocol-core/camera-link/src/session.cjs';
import transport from './protocol-core/camera-link/src/node-transport.cjs';
import blocks from './protocol-core/camera-link/src/received-block.cjs';
import starts from './protocol-core/camera-link/src/start-status.cjs';
import races from './protocol-core/camera-link/src/race-start.cjs';
import captures from './protocol-core/camera-link/src/capture-udp.cjs';
import identity from './protocol-core/camera-link/src/passive-identity.cjs';
import participants from './protocol-core/src/ppl.cjs';
import events from './protocol-core/src/evt.cjs';
import schedule from './protocol-core/src/sch.cjs';
import results from './protocol-core/src/result.cjs';
import time from './protocol-core/src/time.cjs';
import still from './protocol-core/src/still.cjs';
import profiles from './protocol-core/src/profile.cjs';
import formatter from './protocol-core/scoreboard/src/formatter.cjs';
import planner from './protocol-core/scoreboard/src/output-plan.cjs';
import tcpProfile from './protocol-core/scoreboard/src/tcp-profile.cjs';
import tcp from './protocol-core/scoreboard/src/node-tcp.cjs';

export const networkCameraProtocol = Object.freeze({ ...framing, ...session,
  ...transport, ...blocks, ...starts, ...races, ...captures, ...identity });
export const meetDataProtocol = Object.freeze({ participants, events, schedule, results, time, still, profiles });
export * as settingsProtocol from './settings.js';
export const scoreboardWireProtocol = Object.freeze({ formatter, planner, tcpProfile, ...tcp });
