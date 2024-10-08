// MIT License - Copyright (c) 2020 Stefan Arentz <stefan@devbots.xyz>
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.


const fs = require('fs');

const core = require('@actions/core');
const execa = require('execa');
const plist = require('plist');


const sleep = (ms) => {
    return new Promise(res => setTimeout(res, ms));
};


const parseConfiguration = () => {
    const configuration = {
        productPath: core.getInput("product-path", {required: true}),
        username: core.getInput("appstore-connect-username", {required: true}),
        teamid: core.getInput("appstore-connect-teamid", {required: true}),
        password: core.getInput("appstore-connect-password", {required: true}),
        verbose: core.getInput("verbose") === "true",
    };

    if (!fs.existsSync(configuration.productPath)) {
        throw Error(`Product path ${configuration.productPath} does not exist.`);
    }

    return configuration
};


const archive = async ({productPath}) => {
    const archivePath = "/tmp/archive.zip"; // TODO Temporary file

    const args = [
        "-c",           // Create an archive at the destination path
        "-k",           // Create a PKZip archive
        "--keepParent", // Embed the parent directory name src in dst_archive.
        productPath,    // Source
        archivePath,    // Destination
    ];

    try {
        await execa("ditto", args);
    } catch (error) {
        core.error(error);
        return null;
    }

    return archivePath;
};


var uuid = "<unknown>";

const fetchlog = async ({uuid, username, teamid, password, verbose}) => {
    //
    // Run notarytool to notarize this application. This only submits the
    // application to the queue on Apple's server side. It does not
    // actually tell us if the notarization was succesdful or not, for
    // that we need to poll using the request UUID that is returned.
    //

    const args = [
        "notarytool",
        "log",
        "--apple-id", username,
        "--team-id", teamid,
        "--password", password,
        uuid
    ];

    if (verbose === true) {
        args.push("--verbose");
    }

    let xcrun = execa("xcrun", args, {reject: false});

    xcrun.stdout.pipe(process.stdout);
    xcrun.stderr.pipe(process.stderr);

    const {exitCode, stdout, stderr} = await xcrun;

    if (exitCode === undefined) {
        // TODO Command did not run at all
        throw Error("Unknown failure - notarytool did not run at all?");
    }

    if (exitCode !== 0) {
        const response = JSON.parse(stdout);
        if (verbose === true) {
            console.log("STDERR", stderr);
            console.log(response);
        }

        for (const productError of response["product-errors"]) {
            core.error(`${productError.code} - ${productError.message}`);
        }
        return false;
    }

    return true;
};

const submit = async ({archivePath, username, teamid, password, verbose}) => {
    //
    // Run notarytool to notarize this application. This only submits the
    // application to the queue on Apple's server side. It does not
    // actually tell us if the notarization was succesdful or not, for
    // that we need to poll using the request UUID that is returned.
    //

    const args = [
        "notarytool",
        "submit",
        "--wait",
        "--apple-id", username,
        "--team-id", teamid,
        "--password", password,
        archivePath
    ];

    if (verbose === true) {
        args.push("--verbose");
    }

    let xcrun = execa("xcrun", args, {reject: false});

    xcrun.stdout.pipe(process.stdout);
    xcrun.stderr.pipe(process.stderr);

    const {exitCode, stdout, stderr} = await xcrun;

    // try parse the UUID from the output
    // I don't know if this is going to work or not
    const lines = stdout.split("\n");
    for (i = 0; i < lines.length; i++) {
        var d = lines[i].trim();
        if (d.startsWith("id: ")) {
            uuid = d.split(": ")[1];
            console.log("detected submission UUID: " + uuid);
        }
    }

    if (exitCode === undefined) {
        // TODO Command did not run at all
        throw Error("Unknown failure - notarytool did not run at all?");
    }

    if (exitCode !== 0) {
        const response = JSON.parse(stdout);
        if (verbose === true) {
            console.log("STDERR", stderr);
            console.log(response);
        }

        for (const productError of response["product-errors"]) {
            core.error(`${productError.code} - ${productError.message}`);
        }
        return false;
    }

    return true;
};

const main = async () => {
    try {
        const configuration = parseConfiguration();

        const archivePath = await core.group('Archiving Application', async () => {
            const archivePath = await archive(configuration)
            if (archivePath !== null) {
                core.info(`Created application archive at ${archivePath}`);
            }
            return archivePath;
        });

        if (archivePath == null) {
            core.setFailed("Notarization failed");
            return;
        }

        const success = await core.group('Waiting for Notarization Status', async () => {
            return await submit({archivePath: archivePath, ...configuration})
        });

        // "Always check the notary log, even if notarization succeeds, 
        // because it might contain warnings that you can fix prior to your next submission."
        const log = await core.group('Fetching notarization log', async () => {
            return await fetchlog({uuid: uuid, ...configuration})
        });

        if (success == false) {
            core.setFailed("Notarization failed");
            return;
        }
        if (log == false) {
            core.setFailed("Notarization log failed");
            return;
        }

        core.setOutput('product-path', configuration.productPath);
    } catch (error) {
        core.setFailed(`Notarization failed with an unexpected error: ${error.message}`);
    }
};


main();
