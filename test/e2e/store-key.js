// Stores a fake API key in the sandbox keyring, through the same code path the prefs use.
import GLib from 'gi://GLib';

import {lookupApiKey, storeApiKey} from '../../lib/secret.js';

const loop = new GLib.MainLoop(null, false);
storeApiKey('sk-ant-e2e-test-key')
    .then(() => lookupApiKey())
    .then(key => print(`sandbox keyring: stored key ending in ${key.slice(-4)}`))
    .catch(e => printerr(`could not store key: ${e.message}`))
    .finally(() => loop.quit());
loop.run();
