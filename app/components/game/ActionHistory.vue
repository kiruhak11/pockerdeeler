<script setup lang="ts">
import type { OnlinePlayerAction } from '~/types/game'

defineProps<{
  actions: OnlinePlayerAction[]
}>()
</script>

<template>
  <section class="panel">
    <h3>Последние действия</h3>
    <ul>
      <li v-for="action in actions" :key="action.id">
        {{ action.type }} {{ action.amount }} ({{ action.status }})
      </li>
    </ul>
  </section>
</template>
