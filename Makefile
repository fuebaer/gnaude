UUID := gnaude@n2soft.de
DOMAIN := gnaude
EXTENSIONS_DIR := $(HOME)/.local/share/gnome-shell/extensions
INSTALL_DIR := $(EXTENSIONS_DIR)/$(UUID)
MOCK_PORT ?= 18765

LINGUAS := de es fr it
JS_SOURCES := extension.js prefs.js $(wildcard lib/*.js)
MO_FILES := $(LINGUAS:%=locale/%/LC_MESSAGES/$(DOMAIN).mo)

.PHONY: all schemas translations pot update-po check-po install uninstall pack test clean

all: schemas translations

schemas: schemas/gschemas.compiled

schemas/gschemas.compiled: schemas/*.gschema.xml
	glib-compile-schemas --strict schemas

translations: $(MO_FILES)

locale/%/LC_MESSAGES/$(DOMAIN).mo: po/%.po
	mkdir -p $(dir $@)
	msgfmt --check -o $@ $<

# Extract translatable strings (English source) into the template.
pot:
	xgettext --from-code=UTF-8 --language=JavaScript \
		--keyword=_ --keyword=N_ --keyword=ngettext:1,2 \
		--add-comments=Translators --package-name=Gnaude \
		--output=po/$(DOMAIN).pot $(JS_SOURCES)

update-po: pot
	for lang in $(LINGUAS); do msgmerge --quiet --update --backup=none po/$$lang.po po/$(DOMAIN).pot; done

# Every catalog must be complete: no untranslated or fuzzy messages.
check-po:
	@for lang in $(LINGUAS); do \
		stats=$$(msgfmt --check --statistics -o /dev/null po/$$lang.po 2>&1) || exit 1; \
		echo "$$lang: $$stats"; \
		case "$$stats" in *untranslated*|*fuzzy*) exit 1;; esac; \
	done

# Development install: symlink this checkout into the extensions directory,
# so a re-login picks up code changes without copying.
install: schemas translations
	mkdir -p $(EXTENSIONS_DIR)
	ln -sfn $(CURDIR) $(INSTALL_DIR)
	@echo "Linked $(INSTALL_DIR) -> $(CURDIR)"

uninstall:
	rm -f $(INSTALL_DIR)

# Zip for `gnome-extensions install` or extensions.gnome.org.
pack: schemas
	mkdir -p dist
	gnome-extensions pack --force --out-dir=dist --extra-source=lib --podir=po .

test: check-po
	@python3 test/mock_server.py $(MOCK_PORT) & pid=$$!; \
	sleep 0.5; \
	gjs -m test/unit.js http://127.0.0.1:$(MOCK_PORT); status=$$?; \
	kill $$pid; exit $$status

clean:
	rm -rf dist locale schemas/gschemas.compiled
