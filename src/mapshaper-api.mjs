import { enableLogging, disableLogging } from './utils/mapshaper-logging.mjs';
import { runCommands, applyCommands, runCommandsXL } from './cli/mapshaper-run-commands.mjs';

import cmd from './mapshaper-cmd';
import internal from './mapshaper-internal';
import geom from './geom/mapshaper-geom';
import utils from './utils/mapshaper-utils';
import cli from './cli/mapshaper-cli-utils';

// the mapshaper public api only has 4 functions
var api = {
  runCommands,
  applyCommands,
  runCommandsXL,
  enableLogging,
  disableLogging
};

// Add some namespaces, for easier testability and
// to expose internal functions to the web UI
Object.assign(api, {
  cli, cmd, geom, utils, internal,
});

export default api;
