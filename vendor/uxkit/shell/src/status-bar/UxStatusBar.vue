<template>
  <footer class="ux-statusbar" data-ux="statusbar">
    <div class="ux-statusbar__left" data-ux-part="statusbar-left"><slot /></div>
    <div class="ux-statusbar__right" data-ux-part="statusbar-right"><slot name="right" /></div>
  </footer>
</template>
