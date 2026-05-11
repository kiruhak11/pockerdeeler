<script setup lang="ts">
const props = defineProps<{
  code: string
  inviteUrl: string
}>()

const copied = ref(false)
const showShareButton = ref(false)
const canShare = computed(
  () => import.meta.client && typeof navigator !== 'undefined' && typeof navigator.share === 'function'
)

async function copyLink() {
  await navigator.clipboard.writeText(props.inviteUrl)
  copied.value = true
  showShareButton.value = true
  setTimeout(() => {
    copied.value = false
  }, 1500)
}

async function shareLink() {
  if (!canShare.value) {
    return
  }

  await navigator.share({
    title: `Покерная комната ${props.code}`,
    text: `Присоединяйтесь к комнате ${props.code}`,
    url: props.inviteUrl
  })
}
</script>

<template>
  <section class="panel room-code-card">
    <h3>Код комнаты</h3>
    <p class="room-code-card__code">{{ code }}</p>
    <p class="room-code-card__url">{{ inviteUrl }}</p>
    <div class="room-code-card__actions">
      <button type="button" class="btn btn--ghost" @click="copyLink">{{ copied ? 'Скопировано' : 'Копировать ссылку' }}</button>
      <button v-if="showShareButton && canShare" type="button" class="btn" @click="shareLink">Поделиться</button>
    </div>
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

  &__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
}
</style>
