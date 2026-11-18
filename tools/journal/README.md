# @repo/journal

Replays a framework bot's journal file on your machine, so you can ask what the bot believed at a
step, or about a key, after an incident.

```sh
bun run journal verify <file>                               # replay it; name the first diverging node
bun run journal show <file> --at <seq> [--node <id> | --key <key>]
bun run journal history <file> --key <key>                  # every step where the key's records changed
bun run journal where <file>                                # last step, failures, recoveries, how it ended
```

Run it from the repository root, or give an absolute path. It reads the file one line at a time:
reading a 1 GiB file peaked at 144 MiB of memory.

## Output

Output is plain text, one fact per line, and the same for the same file and build. A replay on a
checkout whose tracked files differ from that build adds a warning line. Each write is labeled:

- `recorded`: an input the journal holds as it arrived, from a source, an effect's result or a
  clock.
- `verified`: a value an operator derived on replay, matched against the journal's digest.

For a key, `show` and `history` print the key's record in each keyed level, and the part of a keyed
input that names it.

Exit codes: `0` when the command ran, `1` when the replay diverged or the file is corrupt, `2` when
it refused, for bad arguments, a missing file, or a journal it cannot replay.

## What it replays

The CLI loads `bots/<graph>/src/replay.ts`, where `<graph>` is the graph id in the file's header,
and refuses a file that another build wrote: check out the header's `build` revision first. A bot
becomes replayable by exporting `replayGraph` from that file, with its graph id equal to its
directory name. The module rebuilds the graph the run declared from the settings its header records,
so a production journal replays as exactly as a test's. The CLI refuses a graph id that is not a
kebab-case directory name, a bot with no replay module, a header with no settings, and settings
this build's schema does not accept.

`where` only reads the file, so it works on any journal, from any build.
