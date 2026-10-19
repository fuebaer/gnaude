// Mirrors what GNOME Shell's ui/environment.js does before any extension loads,
// so the unit tests see the same promisified Gio methods as the shell.
import Gio from 'gi://Gio';

Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async');
