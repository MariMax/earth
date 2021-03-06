/**
 * grids - interpolates grids of weather data
 *
 * Copyright (c) 2014 Cameron Beccario
 * The MIT License - http://opensource.org/licenses/MIT
 *
 * https://github.com/cambecc/earth
 */
var layers = function() {
    "use strict";

    var LAYER_RECIPES = {
        wi10: {
            name: "wind-isobaric-10hPa",
            description: "Wind Velocity @ 10 hPa"
        },
        wi70: {
            name: "wind-isobaric-70hPa",
            description: "Wind Velocity @ 70 hPa"
        },
        wi250: {
            name: "wind-isobaric-250hPa",
            description: "Wind Velocity @ 250 hPa"
        },
        wi500: {
            name: "wind-isobaric-500hPa",
            description: "Wind Velocity @ 500 hPa"
        },
        wi700: {
            name: "wind-isobaric-700hPa",
            description: "Wind Velocity @ 700 hPa"
        },
        wi850: {
            name: "wind-isobaric-850hPa",
            description: "Wind Velocity @ 850 hPa"
        },
        wi1000: {
            name: "wind-isobaric-1000hPa",
            description: "Wind Velocity @ 1000 hPa"
        }
    };

    function recipeFor(type) {
        return _.findWhere(_.values(LAYER_RECIPES), {name: [type.param, type.surface, type.level].join("-")});
    }

    function bilinear(x, y, g00, g10, g01, g11) {
        var a = (1 - x) * (1 - y);
        var b = x * (1 - y);
        var c = (1 - x) * y;
        var d = x * y;
        var u = g00[0] * a + g10[0] * b + g01[0] * c + g11[0] * d;
        var v = g00[1] * a + g10[1] * b + g01[1] * c + g11[1] * d;
        return [u, v, Math.sqrt(u * u + v * v)];
    }

    /**
     * Builds an interpolator for the specified data in the form of JSON-ified GRIB files. Example:
     *
     *     [
     *       {
     *         "header": {
     *           "refTime": "2013-11-30T18:00:00.000Z",
     *           "parameterNumber": 2,
     *           "forecastTime": 6,
     *           "scanMode": 0,
     *           "nx": 360,
     *           "ny": 181,
     *           "lo1": 0,
     *           "la1": 90,
     *           "lo2": 359,
     *           "la2": -90,
     *           "dx": 1,
     *           "dy": 1
     *         },
     *         "data": [3.42, 3.31, 3.19, 3.08, 2.96, 2.84, 2.72, 2.6, 2.47, ...]
     *       }
     *     ]
     *
     */
    function buildGrid(data) {

        var uRecord = null, vRecord = null;
        for (var r = 0; r < data.length; r++) {
            var record = data[r];
            switch (record.header.parameterNumber) {
                case 2: uRecord = record; break; // U-component_of_wind
                case 3: vRecord = record; break; // V-component_of_wind
            }
        }
        if (!uRecord || !vRecord) {
            return when.reject("Failed to find both u,v component records");
        }

        var header = uRecord.header;
        var λ0 = header.lo1, φ0 = header.la1;  // the grid's origin (e.g., 0.0E, 90.0N)
        var Δλ = header.dx, Δφ = header.dy;    // distance between grid points (e.g., 2.5 deg lon, 2.5 deg lat)
        var ni = header.nx, nj = header.ny;    // number of grid points W-E and N-S (e.g., 144 x 73)
        var uData = uRecord.data, vData = vRecord.data;
        if (uData.length != vData.length) {
            return when.reject("Mismatched data point lengths");
        }
        var date = new Date(header.refTime);
        date.setHours(date.getHours() + header.forecastTime);

        // Scan mode 0 assumed. Longitude increases from λ0, and latitude decreases from φ0.
        // http://www.nco.ncep.noaa.gov/pmb/docs/grib2/grib2_table3-4.shtml
        var grid = [], p = 0;
        var isContinuous = Math.floor(ni * Δλ) >= 360;
        for (var j = 0; j < nj; j++) {
            var row = [];
            for (var i = 0; i < ni; i++, p++) {
                row[i] = [uData[p], vData[p]];
            }
            if (isContinuous) {
                // For wrapped grids, duplicate first column as last column to simplify interpolation logic
                row.push(row[0]);
            }
            grid[j] = row;
        }

        function interpolate(λ, φ) {
            var i = µ.floorMod(λ - λ0, 360) / Δλ;  // calculate longitude index in wrapped range [0, 360)
            var j = (φ0 - φ) / Δφ;                 // calculate latitude index in direction +90 to -90

            //         1      2           After converting λ and φ to fractional grid indexes i and j, we find the
            //        fi  i   ci          four points "G" that enclose point (i, j). These points are at the four
            //         | =1.4 |           corners specified by the floor and ceiling of i and j. For example, given
            //      ---G--|---G--- fj 8   i = 1.4 and j = 8.3, the four surrounding grid points are (1, 8), (2, 8),
            //    j ___|_ .   |           (1, 9) and (2, 9).
            //  =8.3   |      |
            //      ---G------G--- cj 9   Note that for wrapped grids, the first column is duplicated as the last
            //         |      |           column, so the index ci can be used without taking a modulo.

            var fi = Math.floor(i), ci = fi + 1;
            var fj = Math.floor(j), cj = fj + 1;

            var row;
            if ((row = grid[fj])) {
                var g00 = row[fi];
                var g10 = row[ci];
                if (g00 && g10 && (row = grid[cj])) {
                    var g01 = row[fi];
                    var g11 = row[ci];
                    if (g01 && g11) {
                        // All four points found, so use bilinear interpolation to calculate the wind vector.
                        return bilinear(i - fi, j - fj, g00, g10, g01, g11);
                    }
                }
            }
            // console.log("cannot interpolate: " + λ + "," + φ + ": " + fi + " " + ci + " " + fj + " " + cj);
            return null;
        }

        return {
            date: date,
            interpolate: interpolate
        };
    }

    return {
        buildGrid: buildGrid,
        recipeFor: recipeFor
    };

}();
