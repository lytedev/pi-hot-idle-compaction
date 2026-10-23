{
  description = "pi-hot-idle-compaction development shell";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
        "x86_64-darwin"
      ];
      forEachSystem = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forEachSystem (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          publishThroughTheMaintainersCheckedPublisher = pkgs.writeShellApplication {
            name = "publish";
            text = ''
              if ! command -v npm-publish-checked >/dev/null; then
                echo "publish: npm-publish-checked is not on PATH; it is the maintainer's release tool (lytedev/nix lib/scripts/common/bin)." >&2
                exit 1
              fi
              exec npm-publish-checked "$@"
            '';
          };
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_24
              publishThroughTheMaintainersCheckedPublisher
            ];
          };
        }
      );
    };
}
