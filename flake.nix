{
  description = "OpenCode V2 plugin: edit the system prompt and conversation history the model sees in $EDITOR";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      # Systems bun (used by the checks) supports.
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      # The plugin directory itself: OpenCode loads the .ts sources directly and resolves
      # @opencode/plugin at runtime, so there is nothing to build or install.
      packages = forAllSystems (pkgs: {
        default = pkgs.runCommand "opencode-prefix-editor" { } ''
          mkdir $out
          cp -r ${./src} $out/src
          cp ${./package.json} $out/package.json
        '';
      });

      checks = forAllSystems (pkgs: {
        # The tests only need bun: format.ts imports @opencode/plugin for types alone.
        default = pkgs.runCommand "opencode-prefix-editor-test" { nativeBuildInputs = [ pkgs.bun ]; } ''
          cp -r --no-preserve=mode ${./src} src
          cp -r --no-preserve=mode ${./test} test # bun opens snapshots writable
          HOME=$TMPDIR CI=true bun test
          touch $out
        '';
      });
    };
}
