import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { encodePng } from '../../sim/png-encode.js';

export async function replayFixture(root, type = 'real-replay') {
  const dir = path.join(root, 'replay'), meetDir = path.join(dir, 'meet');
  await mkdir(meetDir, { recursive: true });
  await mkdir(path.join(dir, 'heat-1'));
  await mkdir(path.join(dir, 'heat-2'));
  await writeFile(path.join(meetDir, 'lynx.evt'), '5,1,1,Generated 100m\n,101,2,Example,Ada,Club\n6,1,1,Other heat\n,102,3,Sample,Sam,Club\n');
  const cameras = [];
  for (const [i, id] of ['primary', 'backup', 'scan-far'].entries()) {
    const image = { width: 96, height: 5 + 3 * i, channels: 3, data: Buffer.alloc(96 * (5 + 3 * i) * 3) };
    for (let n = 0; n < image.data.length; n++) image.data[n] = (n * (7 + i) + 19 * i) % 256;
    const meta = { column_period_s: .00125 * 2 ** i, first_column_race_time_s: .005 * 2 ** i,
      camera_name: `Generated camera ${i + 1}`, truth: [{ lane: 2, time_s: .05 }] };
    const png = path.join(dir, 'heat-1', `${id}.png`), sidecar = path.join(dir, 'heat-1', `${id}.json`);
    await writeFile(png, encodePng(image));
    await writeFile(sidecar, JSON.stringify(meta));
    cameras.push({ id, png, sidecar, image, meta });
  }
  await writeFile(path.join(dir, 'heat-2', 'primary.png'), encodePng(cameras[0].image));
  await writeFile(path.join(dir, 'heat-2', 'primary.json'), JSON.stringify(cameras[0].meta));
  await writeFile(path.join(dir, 'heat-1', 'front.mp4'), 'Generated front-video retention fixture');
  await writeFile(path.join(dir, 'openmeet-replay.json'), JSON.stringify({ version: 1, type, heats: [
    { folder: 'heat-1', event: '5', round: 1, heat: 1 }, { folder: 'heat-2', event: '6', round: 1, heat: 1 },
  ] }));
  return { dir, meetDir, cameras };
}
