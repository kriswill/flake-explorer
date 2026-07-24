// Reverse-dependency index over the flake's OWN packages — port of
// src/extract/reverse-deps.ts. The sound join key is drvPath; matches are
// false-positive-free and the index is silently PARTIAL over whatever
// package set it is given.

use crate::schema::PackageData;
use indexmap::IndexMap;
use std::collections::{HashMap, HashSet};

/// Depended-on package refId -> sorted refIds that depend on it.
pub fn build_package_reverse_deps(
    package_data: &IndexMap<String, PackageData>,
) -> IndexMap<String, Vec<String>> {
    // drvPath -> owning refIds. A LIST, not one id: aliased outputs share a
    // drvPath and both must be credited.
    let mut by_drv: HashMap<&str, Vec<&str>> = HashMap::new();
    for (id, data) in package_data {
        if let Some(drv) = &data.drv {
            by_drv.entry(drv.drv_path.as_str()).or_default().push(id.as_str());
        }
    }

    let mut reverse: IndexMap<String, Vec<String>> = IndexMap::new();
    for (id, data) in package_data {
        let mut seen: HashSet<&str> = HashSet::new();
        for inp in data.drv.iter().flat_map(|d| d.input_drvs.iter()) {
            for dep in by_drv.get(inp.drv_path.as_str()).into_iter().flatten() {
                if *dep == id.as_str() || !seen.insert(dep) {
                    continue;
                }
                reverse.entry(dep.to_string()).or_default().push(id.clone());
            }
        }
    }
    for v in reverse.values_mut() {
        v.sort();
    }
    reverse
}
