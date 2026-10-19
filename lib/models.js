// Shared between the shell process (extension.js) and the prefs process (prefs.js),
// so this module must only use plain JS. Translatable names are only marked with
// N_() for xgettext; callers translate them with their process's gettext.

const N_ = text => text;

// `fallbacks`: the model accepts server-side refusal fallbacks (`fallbacks: "default"`).
// Claude Haiku 5.5 has no server-side fallback and must not receive the parameter.
export const MODELS = [
    {id: 'claude-opus-5-5', name: 'Claude Opus 5.5', fallbacks: true},
    {id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', fallbacks: true},
    {id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', fallbacks: false},
    {id: 'claude-fable-5-1', name: 'Claude Fable 5.1', fallbacks: true},
];

// `short` labels the effort button in the prompt dialog.
export const EFFORTS = [
    {id: 'low', name: N_('Low (fastest)'), short: N_('Low')},
    {id: 'medium', name: N_('Medium'), short: N_('Medium')},
    {id: 'high', name: N_('High'), short: N_('High')},
    {id: 'xhigh', name: N_('Very high'), short: N_('Very high')},
    {id: 'max', name: N_('Maximum'), short: N_('Maximum')},
];

export function findModel(id) {
    return MODELS.find(m => m.id === id) ?? {id, name: id, fallbacks: false};
}
