import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

test('crashed Rocket bets with zero payout render as losses instead of cashouts', () => {
  const source = readFileSync(resolve(process.cwd(), 'app/components/minigames/RocketGame.vue'), 'utf8')
  assert.match(source, /round\.phase === 'crashed' && data\.value\.bet\.payout <= 0/)
  assert.match(source, /class="lost">проиграно на/)
  assert.match(source, /item\.cashedAt && item\.payout > 0/)
  assert.match(source, /\.bet-status em\.lost\s*\{\s*color:\s*#ff8b75/)
})
