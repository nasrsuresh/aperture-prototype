// Generate test images of roughly a target size. Random noise does not
// compress, so a PNG of noise is about width*height*3 bytes.
//
//   npm run cli:gen -- <dir> <count> [--mb 2] [--prefix img]
//   npm run cli:gen -- <dir> 1 --mb 25 --prefix big
//   npm run cli:gen -- <dir> 1 --random-bytes 3   (not an image at all)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

async function main() {
  const [dir, countStr] = process.argv.slice(2);
  if (!dir || !countStr) {
    console.error('usage: gen-images <dir> <count> [--mb N] [--prefix P] [--random-bytes N]');
    process.exit(2);
  }
  mkdirSync(dir, { recursive: true });
  const count = Number(countStr);
  const prefix = arg('prefix', 'img')!;
  const randomMb = arg('random-bytes');
  const mb = Number(arg('mb', '2'));

  for (let i = 1; i <= count; i += 1) {
    const name = `${prefix}-${String(i).padStart(3, '0')}`;
    if (randomMb) {
      const path = join(dir, `${name}.bin`);
      writeFileSync(path, randomBytes(Math.round(Number(randomMb) * 1024 * 1024)));
      console.log(`${path}  (${randomMb} MB of random bytes, not an image)`);
      continue;
    }
    const pixels = (mb * 1024 * 1024) / 3;
    const side = Math.round(Math.sqrt(pixels));
    const raw = randomBytes(side * side * 3);
    const png = await sharp(raw, { raw: { width: side, height: side, channels: 3 } })
      .png({ compressionLevel: 1 })
      .toBuffer();
    const path = join(dir, `${name}.png`);
    writeFileSync(path, png);
    console.log(`${path}  ${side}x${side}  ${(png.length / 1024 / 1024).toFixed(2)} MB`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
