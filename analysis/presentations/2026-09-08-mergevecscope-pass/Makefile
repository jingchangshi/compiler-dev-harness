.PHONY: preview render diagrams clean check

QUARTO ?= quarto

preview: diagrams
	$(QUARTO) preview slides.qmd

render: diagrams
	$(QUARTO) render slides.qmd

diagrams:
	./scripts/export-diagrams.sh

check:
	python3 scripts/check_project.py

clean:
	rm -rf _site .quarto
