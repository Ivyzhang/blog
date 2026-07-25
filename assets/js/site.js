(function () {
  document.querySelectorAll('.code-expand').forEach(function (button) {
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', function () {
      var wrapper = button.closest('.code-fold');
      var expanded = wrapper.classList.toggle('is-expanded');
      button.textContent = expanded ? '收起代码' : '查看全部代码';
      button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    });
  });

  var buttons = document.querySelectorAll('[data-filter]');
  var cards = document.querySelectorAll('[data-categories]');
  var emptyState = document.querySelector('[data-empty-state]');

  if (!buttons.length || !cards.length) return;

  buttons.forEach(function (button) {
    button.addEventListener('click', function () {
      var filter = button.getAttribute('data-filter');
      var visibleCount = 0;

      buttons.forEach(function (item) {
        var active = item === button;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-pressed', active ? 'true' : 'false');
      });

      cards.forEach(function (card) {
        var matches = filter === 'all' || card.getAttribute('data-categories').indexOf(filter) !== -1;
        card.hidden = !matches;
        if (matches) visibleCount += 1;
      });

      if (emptyState) emptyState.hidden = visibleCount !== 0;
    });
  });
})();
