/** @type {import('@bacons/apple-targets/app.plugin').Config} */
module.exports = {
  type: "widget",
  name: "RebelVoiceWidget",
  displayName: "Rebel Voice",
  icon: "../../assets/icon.png",
  colors: {
    $widgetBackground: "#0a0a0e",
    $accent: "#8b5cf6",
  },
  deploymentTarget: "17.0",
  bundleIdentifier: ".widget",
  entitlements: {
    "com.apple.security.application-groups": ["group.com.mindstone.rebel.mobile"],
  },
};
