// Minimal stand-ins for OVMS-injected globals that the module touches broadly.
// Per-test stubs (OvmsMetrics, HTTP, …) are added inside the tests that need them.
global.print = function () {}
global.performance = {
  now: function () {
    return 0
  },
}
