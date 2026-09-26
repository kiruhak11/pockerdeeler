<script setup lang="ts">
import BlackjackGame from '~/components/minigames/BlackjackGame.vue'
import AppIcon from '~/components/ui/AppIcon.vue'
const auth = useAccountAuth()
onMounted(() => void auth.loadMe().catch(() => {}))
useHead({ title: 'Блэкджек · Poker Dealer Desk' })
</script>
<template><main class="arcade blackjack-page"><NuxtLink class="arcade-back" to="/minigames"><AppIcon name="arrow-left" :size="16" /> Все мини-игры</NuxtLink><BlackjackGame/></main></template>
<style src="~/assets/css/arcade.css"/>
