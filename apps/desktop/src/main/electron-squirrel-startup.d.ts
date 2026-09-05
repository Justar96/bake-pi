/**
 * The package ships no types. Its whole surface is one boolean: `true` when
 * this launch was Squirrel installing, updating or removing the app and the
 * shortcut work has been done, `false` for an ordinary start.
 */
declare module "electron-squirrel-startup" {
  const handled: boolean
  export default handled
}
