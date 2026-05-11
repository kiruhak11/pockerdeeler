<script setup lang="ts">
import type { Player } from '~/types/game'

defineProps<{
  players: Player[]
}>()
</script>

<template>
  <section class="panel">
    <h3>Игроки за столом</h3>
    <ul>
      <li v-for="player in players" :key="player.id">
        {{ player.seat }}. {{ player.name }} — {{ player.stack }} ({{ player.status }})
      </li>
    </ul>
  </section>
</template>
