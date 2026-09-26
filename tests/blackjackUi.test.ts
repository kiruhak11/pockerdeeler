import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('mini-game lobby links to Blackjack and its screen supports the round states', async () => {
  const [lobby, page, component] = await Promise.all([
    readFile(new URL('../app/pages/minigames/index.vue', import.meta.url), 'utf8'),
    readFile(new URL('../app/pages/minigames/blackjack.vue', import.meta.url), 'utf8'),
    readFile(new URL('../app/components/minigames/BlackjackGame.vue', import.meta.url), 'utf8')
  ])
  assert.match(lobby, /to="\/minigames\/blackjack"/)
  assert.match(lobby, /Blackjack/)
  assert.match(page, /<BlackjackGame\s*\/>/)
  assert.match(component, /round\?\.status === 'ACTIVE'/)
  assert.match(component, /round\?\.status === 'FINISHED'/)
  assert.match(component, /'hidden' in card/)
  assert.match(component, /canDouble/)
  assert.match(component, /Удвоить/)
  assert.match(component, /action\('double'\)/)
  assert.match(component, /canSplit/)
  assert.match(component, /action\('split'\)/)
  assert.match(component, /expectedRevision: round\.value\.actionRevision/)
  assert.match(component, /bj-split-hands/)
  assert.match(component, /activeHandIndex === index/)
  assert.match(component, /@media\(max-width:600px\)\{\.bj-actions\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/)
  assert.match(component, /Играть снова/)
})
