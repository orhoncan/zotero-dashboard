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
        document.documentElement.classList.toggle('theme-light', this.theme === 'light');
      },
    };
  });
})(window);
