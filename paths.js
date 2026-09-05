// Where this repo finds dg-node (the website — source of truth for the UI and, later, for the
// shared request handlers) and the legacy PHP repo's asset tree.
//
// mobile/ used to live INSIDE dg-node, so every build script just walked `__dirname/..`. Now that
// the app is its own repository that assumption is gone and the location has to be told to us:
//
//   DG_NODE_PATH        absolute path to a dg-node checkout   (default: the prod path)
//   DG_LEGACY_ASSETS    absolute path to the legacy asset tree
//                       (default: dg-node's own siteroot/assets symlink, which points at it)
//
// The defaults are the production layout described in dg-node's CLAUDE.md:
//   /var/www/html/          <- dhammagift/dg      (legacy PHP repo)
//   /var/www/html/nodejs/   <- dhammagift/dg-node (the website)
// CI reproduces those exact absolute paths on purpose — dg-node carries git-tracked RELATIVE
// symlinks that only resolve at that directory depth (see .github/workflows/build-app.yml).

const fs = require('fs');
const path = require('path');

const DEFAULT_NODE_PATH = '/var/www/html/nodejs';
const DEFAULT_LEGACY_ASSETS = '/var/www/html/assets';

const NODEJS_ROOT = path.resolve(process.env.DG_NODE_PATH || DEFAULT_NODE_PATH);

// Prefer dg-node's own siteroot/assets symlink over the hardcoded legacy path: it is the same
// tree, but reached the way the server itself reaches it, so a dg-node checkout that relocates
// its assets keeps working without a second env var.
function resolveLegacyAssets() {
    if (process.env.DG_LEGACY_ASSETS) return path.resolve(process.env.DG_LEGACY_ASSETS);
    const viaSiteroot = path.join(NODEJS_ROOT, 'siteroot', 'assets');
    if (fs.existsSync(viaSiteroot)) return viaSiteroot;
    return DEFAULT_LEGACY_ASSETS;
}

const LEGACY_ASSETS = resolveLegacyAssets();

// Fail loudly and with the fix in the message — a missing dg-node checkout otherwise surfaces as
// a pile of "MISSING: /assets/..." warnings that look like a content problem, not a setup one.
function requireNodeRoot() {
    if (!fs.existsSync(path.join(NODEJS_ROOT, 'dg-light.js'))) {
        throw new Error(
            `dg-node not found at ${NODEJS_ROOT} (no dg-light.js there).\n` +
            `Point DG_NODE_PATH at a dg-node checkout, e.g. DG_NODE_PATH=../dg-node npm run build-assets`
        );
    }
}

module.exports = {
    NODEJS_ROOT,
    LEGACY_ASSETS,
    WWW: path.join(__dirname, 'www'),
    SRC: path.join(__dirname, 'src'),
    DIST: path.join(__dirname, 'dist'),
    requireNodeRoot,
    // Resolve a path inside dg-node / inside the legacy asset tree.
    f: rel => path.join(NODEJS_ROOT, rel),
    l: rel => path.join(LEGACY_ASSETS, rel),
};
