import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { encodePng } from '../../../engine/index.js';

// Deliberately generated test pixels, never passed off as actual meet footage.
export async function replayFixture(root, type = 'real-replay') {
  const dir = path.join(root, 'recording');
  await mkdir(path.join(dir, 'meet'), { recursive: true });
  await mkdir(path.join(dir, 'heat-1'));
  const evt = '5,1,1,Recorded 100m\n,,2,Example,Ada,Track Club\n,,4,Untimed,Pat,Track Club\n3,1,1,Another heat\n,301,4,Sample,Sam,Other Club\n';
  await writeFile(path.join(dir, 'meet/lynx.evt'), evt);
  const img = { width: 96, height: 6, channels: 3, data: Buffer.alloc(96 * 6 * 3) };
  for (let i = 0; i < img.data.length; i++) img.data[i] = (i * 7 + 43) % 256;
  const meta = { first_column_race_time_s: .01005, column_period_s: .00125, truth: [{ lane: 2, time_s: .079425, image_column:55, source_column:155,official_seconds:.08 }], provenance: 'generated test image; nominal grid' };
  await writeFile(path.join(dir, 'heat-1/primary.png'), encodePng(img));
  await writeFile(path.join(dir, 'heat-1/primary.json'), JSON.stringify(meta));
  await writeFile(path.join(dir, 'openmeet-replay.json'), JSON.stringify({ version: 1, type, name: 'Recorded test fixture', meet: 'meet', heats: [{ folder: 'heat-1', event: '5', round: 1, heat: 1 }] }));
  return { dir, img, meta };
}
