# Building the mobile Screens dependency

The mobile v5 stack uses a committed tarball from the
[DAK Screens fork](https://github.com/juliusmarminge/react-native-screens/tree/dak-v5.0.0-t3.7).
The fork owns the integration changes; the app does not patch this package.
Each archive includes compiled JavaScript, declarations, native source and
`dak-fork.json` recording its version, source commit and upstream base.

To reproduce the current archive with Node 24 and the repository's pinned Yarn:

```sh
git clone --branch dak-v5.0.0-t3.7 https://github.com/juliusmarminge/react-native-screens.git /tmp/dak-screens-fork
yarn --cwd /tmp/dak-screens-fork pack:t3 /absolute/path/to/dak/apps/mobile/deps
```

For an update, sync the fork's `main` with upstream, merge it and the required
proposal branches into `dak/main`, increment the `5.0.0-t3.N` version, pin `t3Fork.upstreamCommit` to the
integrated upstream SHA and commit.
Run `pack:t3` from that clean checkout and tag the source as `dak-v<version>`.
Replace the old archive, update `apps/mobile/package.json` and run `vp i` to
regenerate the lockfile. Verify mobile types and affected navigation tests.
Changes to native source also require rebuilding and testing the native client.
