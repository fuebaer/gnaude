// API key storage in the user's keyring (libsecret).
// Used by both the shell process and the prefs process.

import Secret from 'gi://Secret';

const ATTRIBUTES = {service: 'anthropic-api-key'};

// Created per call: extensions must not create objects while their modules load.
function schema() {
    return new Secret.Schema('org.gnome.shell.extensions.gnaude',
        Secret.SchemaFlags.NONE, {service: Secret.SchemaAttributeType.STRING});
}

/**
 * @param {Gio.Cancellable} [cancellable]
 * @returns {Promise<string|null>} the stored key, or null
 */
export function lookupApiKey(cancellable = null) {
    return new Promise((resolve, reject) => {
        Secret.password_lookup(schema(), ATTRIBUTES, cancellable, (_source, result) => {
            try {
                resolve(Secret.password_lookup_finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
}

/**
 * @param {string} apiKey
 * @param {Gio.Cancellable} [cancellable]
 * @returns {Promise<boolean>}
 */
export function storeApiKey(apiKey, cancellable = null) {
    return new Promise((resolve, reject) => {
        Secret.password_store(schema(), ATTRIBUTES, Secret.COLLECTION_DEFAULT,
            'Gnaude: Anthropic API key', apiKey, cancellable, (_source, result) => {
                try {
                    resolve(Secret.password_store_finish(result));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

/**
 * @param {Gio.Cancellable} [cancellable]
 * @returns {Promise<boolean>} whether a key was removed
 */
export function clearApiKey(cancellable = null) {
    return new Promise((resolve, reject) => {
        Secret.password_clear(schema(), ATTRIBUTES, cancellable, (_source, result) => {
            try {
                resolve(Secret.password_clear_finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
}
