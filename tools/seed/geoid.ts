// The height of mean sea level above the WGS84 ellipsoid, over the coverage
// area. GPS heights, which is what an aircraft's geometric altitude is, are
// measured from the ellipsoid; subtracting this gives height above sea
// level.
//
// geoid-grid.json is the EGM96 geoid sampled every half degree from 23°N to
// 51°N and 127°W to 65°W, in decimetres. Between grid points it is
// interpolated, which is within 1.1 m of the full model anywhere in the
// coverage area. data/README.md says where the grid came from.

import grid from "./geoid-grid.json";

const FEET_PER_METRE = 1 / 0.3048;

// The geoid's height above the ellipsoid at a point, in feet. Over the
// United States it is negative: sea level is below the ellipsoid. A point
// outside the grid takes the value at the grid's nearest edge.
export function geoidHeightFeet(lat: number, lon: number): number {
	const { south, west, step, rows, cols, decimetres } = grid;
	const y = Math.min(rows - 1, Math.max(0, (lat - south) / step));
	const x = Math.min(cols - 1, Math.max(0, (lon - west) / step));
	const row = Math.min(rows - 2, Math.floor(y));
	const col = Math.min(cols - 2, Math.floor(x));
	const fy = y - row;
	const fx = x - col;
	const at = (r: number, c: number) => decimetres[r * cols + c];
	const metres =
		(at(row, col) * (1 - fy) * (1 - fx) +
			at(row, col + 1) * (1 - fy) * fx +
			at(row + 1, col) * fy * (1 - fx) +
			at(row + 1, col + 1) * fy * fx) /
		10;
	return metres * FEET_PER_METRE;
}
