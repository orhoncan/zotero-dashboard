(function (window) {
  const ns = (window.ZoteroDashboard = window.ZoteroDashboard || {});
  ns.API = "";
  ns.mixins = ns.mixins || [];
  ns.registerMixin = function registerMixin(factory) {
    ns.mixins.push(factory);
  };
})(window);
