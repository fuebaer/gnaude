// API key storage in the user's keyring (libsecret).
// Used by both the shell process and the prefs process.

import Secret from 'gi://Secret';

const SCHEMA = new Secret.Schema('org.gnome.shell.extensions.gnaude',
    Secret.SchemaFlags.NONE, {service: Secret.SchemaAttributeType.STRING});
const ATTRIBUTES = {service: 'anthropic-api-key'};

/** @returns {Promise<string|null>} */
export function lookupApiKey(cancellable = null) {
    return new Promise((resolve, reject) => {
        Secret.password_lookup(SCHEMA, ATTRIBUTES, cancellable, (_source, result) => {
            try {
                resolve(Secret.password_lookup_finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
}

export function storeApiKey(apiKey, cancellable = null) {
    return new Promise((resolve, reject) => {
        Secret.password_store(SCHEMA, ATTRIBUTES, Secret.COLLECTION_DEFAULT,
            'Gnaude: Anthropic API key', apiKey, cancellable, (_source, result) => {
                try {
                    resolve(Secret.password_store_finish(result));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

export function clearApiKey(cancellable = null) {
    return new Promise((resolve, reject) => {
        Secret.password_clear(SCHEMA, ATTRIBUTES, cancellable, (_source, result) => {
            try {
                resolve(Secret.password_clear_finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
}
