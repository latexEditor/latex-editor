(() => {
  const roles = { owner: 'Chủ sở hữu', editor: 'Chỉnh sửa', viewer: 'Chỉ xem' };
  const list = document.querySelector('#list');
  const empty = document.querySelector('#empty');

  window.presenceWindow.onData(({ participants = [], currentUserId = null }) => {
    document.querySelector('#count').textContent = `${participants.length} người`;
    list.replaceChildren();
    for (const person of participants) {
      const item = document.createElement('div');
      item.className = 'person';
      const avatarWrap = document.createElement('div');
      avatarWrap.className = 'avatar-wrap';
      const initials = document.createElement('span');
      initials.className = 'initials';
      initials.textContent = (person.name || '?').trim().slice(0, 1).toLocaleUpperCase('vi-VN');
      avatarWrap.append(initials);
      const userAvatar = person.avatarUrl || person.avatar_url;
      if (userAvatar) {
        const avatar = document.createElement('img');
        avatar.className = 'avatar';
        avatar.alt = '';
        avatar.referrerPolicy = 'no-referrer';
        avatar.src = userAvatar;
        avatar.addEventListener('load', () => initials.remove());
        avatar.addEventListener('error', () => avatar.remove());
        avatarWrap.prepend(avatar);
      }
      const dot = document.createElement('span');
      dot.className = 'online-dot';
      avatarWrap.append(dot);
      const copy = document.createElement('div');
      copy.className = 'copy';
      const name = document.createElement('div');
      name.className = 'name';
      const nameText = document.createElement('span');
      nameText.textContent = person.name || 'Thành viên';
      name.append(nameText);
      if (person.id === currentUserId) {
        const you = document.createElement('span');
        you.className = 'you';
        you.textContent = 'Bạn';
        name.append(you);
      } else {
        item.classList.add('jumpable');
        item.title = `Nhấp để nhảy tới vị trí con trỏ của ${person.name || 'thành viên'}`;
        const jumpHint = document.createElement('span');
        jumpHint.className = 'jump-hint';
        jumpHint.textContent = '👁 Theo dõi';
        name.append(jumpHint);
        item.addEventListener('click', async () => {
          await window.presenceWindow.jumpToUser(person.id);
          window.presenceWindow.close();
        });
      }
      const role = document.createElement('div');
      role.className = 'role';
      role.textContent = roles[person.role] || person.role;
      copy.append(name, role);
      item.append(avatarWrap, copy);
      list.append(item);
    }
    empty.hidden = participants.length > 0;
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') window.presenceWindow.close();
  });
})();
