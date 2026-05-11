<script setup lang="ts">
const props = defineProps<{
  code: string
  inviteUrl: string
}>()

const copied = ref(false)

async function copyLink() {
  await navigator.clipboard.writeText(props.inviteUrl)
  copied.value = true
  setTimeout(() => {
    copied.value = false
  }, 1500)
}
</script>

<template>
  <section class="panel room-code-card">
    <h3>Код комнаты</h3>
    <p class="room-code-card__code">{{ code }}</p>
    <p class="room-code-card__url">{{ inviteUrl }}</p>
    <button type="button" class="btn btn--ghost" @click="copyLink">{{ copied ? 'Скопировано' : 'Копировать ссылку' }}</button>
  </section>
</template>

<style scoped lang="scss">
.room-code-card {
  display: grid;
  gap: 0.5rem;

  h3,
  p {
    margin: 0;
  }

  &__code {
    font-size: 1.5rem;
    font-weight: 700;
    letter-spacing: 0.05em;
  }

  &__url {
    color: var(--text-muted);
    font-size: var(--text-sm);
    overflow-wrap: anywhere;
  }
}
</style>
