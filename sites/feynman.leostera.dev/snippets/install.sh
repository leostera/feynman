bun add -d @leostera/feynman   # the DSL, its types, and the CLI (needs Bun 1.3+)
bunx feynman check             # type-check, run the scenarios, explore, judge every rule
bunx feynman dev               # the simulator, reloading as the spec changes
bunx feynman build             # everything in one self-contained .feynman/index.html
