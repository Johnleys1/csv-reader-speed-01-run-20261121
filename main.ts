import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--no-incremental-marking');

const solver = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => unknown;
};

const sourceDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const targetDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const loaded = JSON.parse(readFileSync(join(sourceDir, 'cases.json'), 'utf8')) as Array<{
  id: string;
  input: unknown;
}>;

writeFileSync(
  join(targetDir, 'answers.json'),
  JSON.stringify(loaded.map((entry) => solver.run(entry.input))),
);
