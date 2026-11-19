// Buildings with a menu, shared by the menu (radar/menu) and the directory (radar/directory).
// step: survey → sample → approved → live. Set from evidence only (a menu made, the building's written OK, menus placed).
// pick: the hand-picked shops (Google place ids, print order) the sales kit links to as the building's menu.
const BUILDING_STATUS = {
  'ChIJ-7PwX7iZ4jARp_rFql-yzO4': { step: 'sample' }, // Aqua Residences
  // AssetWise / THE TITLE, Phuket: condos with residents (checked 2026-11-19). Not approved by the juristic persons yet.
  'ChIJy-staLdHUDARkYkGQxBKqNg': { step: 'sample', name: 'The Title Naiyang Beach', pick: ['ChIJS8s1u11HUDAR8F6XZOAnliU', 'ChIJE8eqE9JHUDAReGu5zhqfRKU', 'ChIJeyc7XDpHUDARsG_-iHVGwaI', 'ChIJF8Jn391HUDARxuOiav004J0', 'ChIJVzwcWVhHUDARI2wvS-4xDDE', 'ChIJwQnwVQBHUDARHEcX3FcS5tg', 'ChIJb1AbRwBHUDAR2g4flcXn4yk', 'ChIJa0Va2d03UDARP_n4irwjCPU'] },
  'ChIJJQguKL0oUDARNrB5R41Seec': { step: 'sample', name: 'The Title V Rawai', pick: ['ChIJwWPlY7woUDAR0hw6Zxvhv9g', 'ChIJjSGUX1kpUDARwrnF51B9364', 'ChIJYcD4Qm4pUDAR-w8P5jZJmms', 'ChIJ3WD6lbcoUDARPkYpJy7EU5U', 'ChIJYRumFiIpUDAR67-7mvYC9ZU', 'ChIJ55CVUQApUDARCndEIFW_Qww', 'ChIJxzWdSQApUDARqToDbrh7nqs', 'ChIJX5BGa9MpUDARgtaFOvvBdSo'] },
  'ChIJffb-KQBHUDAR02avu73pngI': { step: 'sample', name: 'The Title Halo 1', pick: ['ChIJS8s1u11HUDAR8F6XZOAnliU', 'ChIJE8eqE9JHUDAReGu5zhqfRKU', 'ChIJeyc7XDpHUDARsG_-iHVGwaI', 'ChIJF8Jn391HUDARxuOiav004J0', 'ChIJVzwcWVhHUDARI2wvS-4xDDE', 'ChIJwQnwVQBHUDARHEcX3FcS5tg', 'ChIJb1AbRwBHUDAR2g4flcXn4yk', 'ChIJB3g2PgBHUDARq9v456Y5mSs'] },
  'ChIJcfKgdgA5UDARHz2d_LqkntM': { step: 'sample', name: 'The Title Legendary Bang-Tao', pick: ['ChIJx0kN9505UDARwQXiFdbZQ9Q', 'ChIJpaX8eAA5UDARXjy11m5az78', 'ChIJs6SrF-k5UDAR6__igLR3YW0', 'ChIJfWXvbgA5UDARNYZe2uFcWgo', 'ChIJT2qkON05UDARDMFOqsX822M', 'ChIJd4ViFNU5UDAR1BevvkZfkYA', 'ChIJsccxKr85UDAREvd_44EwouI', 'ChIJ05xLXvI3UDARkVnX0A19tW0'] },
};
