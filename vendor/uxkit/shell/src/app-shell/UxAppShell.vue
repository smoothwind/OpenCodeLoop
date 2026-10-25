<template>
  <div class="ux-appshell" data-ux="appshell">
    <slot name="titlebar" />
    <div v-if="$slots.menubar" class="ux-appshell__menubar" data-ux-part="menubar"><slot name="menubar" /></div>
    <div class="ux-appshell__body" data-ux-part="body"><slot /></div>
    <slot name="statusbar" />
  </div>
</template>
