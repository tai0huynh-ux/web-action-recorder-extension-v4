const status = document.getElementById('status');
async function render() { try { const state = await window.warController.system.getBootstrapState(); status.textContent = `Controller ready — ${state.deviceCount} devices, ${state.workflowCount} workflows`; } catch { status.textContent = 'Controller unavailable'; } }
render();
