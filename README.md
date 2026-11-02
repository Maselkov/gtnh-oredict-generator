# GTNH Oredict Card Generator

A single-page web tool for Applied Energistics 2 Oredict cards in GT New Horizons. Search for items, pick a group, and get the shortest card string the page can find that matches exactly that group. You can also paste an existing string to see what it lets through.

**Use it:** https://maselkov.github.io/gtnh-oredict-generator/

## How it works

- **Matching:** `oredict.js` is a port of `OreFilteredList` from [GTNH's AE2](https://github.com/GTNewHorizons/Applied-Energistics-2-Unofficial). `|` and `&` are applied left to right with no precedence, `!` means "has no ore name like this", and `*` gives starts-with, ends-with and contains matches. A string containing `\ ^ $ + ( ) [ ]` is read as one regular expression.
- **Generating:** candidate terms come from the group's ore names: each exact name, plus camelCase prefixes, suffixes and inner parts as wildcards. A greedy set cover picks terms that match the group, then a second cover adds `&!` exclusions for anything else they catch. Several weightings are tried and the shortest exact result wins. The result is checked with the matcher before it is shown.
- **Limits:** items with identical ore names can never be told apart, so picking one includes the others. The page lists these, and anything that cannot be excluded.

## Data

`data/items.json` is built from a [gtnh-craft-monitor-data](https://github.com/Maselkov/gtnh-craft-monitor-data) release:

```bash
python3 build/build_data.py --tag gtnh-data-2.9.0
```

Pass `--images images.zip` to also copy item icons into `icons/`. A `.webp` next to each `.png` path is used when the zip has one. Without icons, the page shows lettered placeholders.

Everything runs in the browser.

## License

GPL-3.0. See [LICENSE](LICENSE).
