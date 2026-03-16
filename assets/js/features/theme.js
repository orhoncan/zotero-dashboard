(function (window) {
  const ns = window.ZoteroDashboard;

  ns.registerMixin(function registerTheme() {
    return {
      toggleTheme() {
        this.theme = this.theme === 'dark' ? 'light' : 'dark';
        localStorage.setItem('zotero-theme', this.theme);
        this.applyTheme();
      },

      applyTheme() {
        const isLight = this.theme === 'light';
        document.documentElement.classList.toggle('theme-light', isLight);
        document.documentElement.classList.toggle('dark', !isLight);
      },
    };
  });
})(window);
