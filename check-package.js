const axios = require('axios');
const git = require('simple-git/promise');
const uuid = require('uuid/v4');
const fs = require('graceful-fs');
const crypto = require('crypto');
const diff = require('diff');
const path = require('path');
const _exec = require('child_process').exec;
const package = require('./test.json');
const Repository = require('github-api/dist/components/Repository');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const repo = new Repository('ISNIT0/safe-npm-packages', {
    token: GITHUB_TOKEN
});

const reportDirectory = `reports/${package.packageName}/${package.version}.json`;

doCheck(package)
    .then(() => {
        console.log(`Package passed the check`);
        const reportContent = JSON.stringify({
            grade: 'C',
            comments: `:robot:
Package check passed on Travis.

[see more](https://travis-ci.org/ISNIT0/npm-package-tester/branches)
`
        }, null, '\t');
        return repo.writeFile('master', reportDirectory, reportContent, `:tada: Automatically applying 'C' grade`, {});
    })
    .catch((err) => {
        console.error(`Package failed the check`, err)
        const reportContent = JSON.stringify({
            grade: 'C',
            comments: `:robot:
Package check failed on Travis.

[see more](https://travis-ci.org/ISNIT0/npm-package-tester/branches)

\`\`\`
${JSON.stringify(err, null, '\t')}
\`\`\`
`
        }, null, '\t');
        return repo.writeFile('master', reportDirectory, reportContent, `:rotating_light: Automatically applying 'F' grade`, {});
    })

function getPackageVersionUrl(package, version) {
    return `http://registry.npmjs.com/${package}/${version}`;
}

async function doCheck({ packageName, version }) {
    const url = getPackageVersionUrl(packageName, version);

    const packageData = await getJSON(url);

    if (!packageData.repository) {
        throw new Error(`Invalid 'package.repository' value, should be an object with keys 'type' and 'url'`);
    }

    const { repository } = packageData;
    if (repository.type !== 'git') {
        throw new Error(`Invalid repository type [${repository.type}], we currently only support git`);
    }

    const dirPath = await getTmpDir(packageName);

    try {
        const gitPath = path.join(dirPath, 'git');
        await mkdir(gitPath);
        const npmPath = path.join(dirPath, 'npm');
        await mkdir(npmPath);

        console.info(`Preparing package from Git [${repository.url}][tag=${version}] -> [${gitPath}]`);
        await cloneVersionToDir(repository.url, version, gitPath);
        console.info(`Building project ([npm run build])`);

        const tarFilePath = path.join(npmPath, `${version}.tgz`);
        console.info(`Downloading tarball [${packageData.dist.tarball}] -> [${tarFilePath}]`);
        await downloadFile(packageData.dist.tarball, tarFilePath, packageData.dist.shasum);
        // await verifyFile(tarFilePath, packageData.dist.shasum);
        await untarFile(tarFilePath, npmPath);
        await exec(`mv ${path.join(npmPath, 'package')}/* ${npmPath}`);

        await buildProject(gitPath);
        await tidyGitRepo(gitPath);

        await buildProject(npmPath);
        await tidyNpmRepo(npmPath);

        const diff = await compareDirs(npmPath, gitPath);

        const validDiffs = diff.filter(d => d.diff.length);
        if (validDiffs.length) {
            console.error(`Diffs for [${packageName}]`, JSON.stringify(validDiffs, null, '\t'));
            throw new Error(`Failed to automatically verify [${packageName}], see logs for diff`);
        }

    } catch (err) {
        console.error(`Error verifying [${packageName}]:`, err);
        throw err;
    } finally {
        console.info(`Clearing up [${packageName}]`);
        // await deleteDir(dirPath);
    }
}

async function compareDirs(refDir, compareDir) {
    const refFilePaths = await getFilesRecursive(refDir);
    const relativeFilePaths = refFilePaths.map(fp => path.relative(refDir, fp));
    const compareFilePaths = relativeFilePaths.map(fp => path.join(compareDir, fp));

    return Promise.all(
        refFilePaths.map(async (refFp, index) => {
            const compareFp = compareFilePaths[index];

            let refFileContent;
            let compareFileContent;

            refFileContent = await readFile(refFp);
            try {
                compareFileContent = await readFile(compareFp);
            } catch (err) {
                console.error(`File present in NPM module that's not present in Git repo. Is the build command correct.`, err);
            }

            return {
                file: relativeFilePaths[index],
                diff: diff.diffTrimmedLines(refFileContent, compareFileContent, { newlineIsToken: true }).filter(d => d.hasOwnProperty('added'))
            };
        })
    );
}

async function untarFile(filePath, targetPath) {
    await exec(`tar -zxvf ${filePath} -C ${targetPath}`);
}

async function tidyGitRepo(dirPath) {
    await exec(`rm -rf ${path.join(dirPath, '.git')}`);
    await exec(`rm -rf ${path.join(dirPath, 'node_modules')}`);
}

async function tidyNpmRepo(dirPath) {
    await exec(`rm -rf ${path.join(dirPath, 'package')}`);
    await exec(`rm -rf ${path.join(dirPath, 'node_modules')}`);
    await exec(`rm -rf ${path.join(dirPath, '*.tgz')}`);
}

function verifyFile(filePath, hash) {
    return new Promise((resolve, reject) => {
        fs.createReadStream(filePath)
            .on('error', reject)
            .pipe(
                crypto.createHash('sha1').setEncoding('hex')
            )
            .once('finish', function () {
                const computedHash = this.read()
                if (computedHash === hash) resolve();
                else reject(`Invalid hash, expected [${hash}] but got [${computedHash}]`);
            });
    });
}

function downloadFile(url, targetPath) {
    return new Promise(async (resolve, reject) => {
        const { data: stream } = await axios({
            url,
            responseType: 'stream',
        });
        const writeStream = fs.createWriteStream(targetPath);
        stream.pipe(writeStream);
        stream.on('error', (err) => {
            reject({ message: `Failed to download [${url}]`, error: err });
            stream.close();
        });
        stream.on('end', () => {
            resolve();
        });
    });
}

async function getTmpDir(prefix) {
    const id = uuid();
    const dirPath = path.join(__dirname, 'tmp', prefix + '__' + id);
    await mkdir(dirPath);

    return dirPath;
}

function getJSON(url) {
    return axios.get(url).then(a => a.data);
}

function mkdir(path) {
    return new Promise((resolve, reject) => {
        fs.mkdir(path, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

async function cloneVersionToDir(remote, version, targetDir) {
    const tidyRemote = remote.replace('git+', '');
    await git().clone(tidyRemote, targetDir);
    const g = git(targetDir);
    await g.fetch();
    const { all: tags } = await g.tags();
    const tag = tags.find(t => t.includes(version));
    console.info(`Using tag [${tag}]`);
    if (!tag) throw new Error(`Couldn't find obvious tag for version [${version}]`);
    await g.checkout(`tags/${tag}`);
}

function exec(cmd) {
    return new Promise((resolve, reject) => {
        _exec(cmd, (err, stdout, stderr) => {
            if (err) reject({ message: `Failed to exec [${cmd}]`, error: err });
            else resolve(stdout + stderr);
        });
    });
}

async function buildProject(targetDir) {
    await exec(`cd ${targetDir} && (npm ci || npm i --no-save)`);
    await exec(`cd ${targetDir} && (npm run build || echo 1)`);
}

async function getFilesRecursive(dirPath) {
    const _files = await readdir(dirPath);
    let files = [];
    for (let file of _files) {
        const filePath = path.join(dirPath, file);
        const isDirectory = await isDir(filePath);
        if (isDirectory) {
            files = files.concat(await getFilesRecursive(filePath));
        } else {
            files.push(filePath);
        }
    }
    return files;
}

function isDir(path) {
    return new Promise((resolve, reject) => {
        fs.stat(path, (err, info) => {
            if (err) reject(err);
            else resolve(info.isDirectory());
        })
    });
}

function readdir(path) {
    return new Promise((resolve, reject) => {
        fs.readdir(path, (err, files) => {
            if (err) reject(err);
            else resolve(files);
        });
    });
}

function readFile(path, encoding = 'utf8') {
    return new Promise((resolve, reject) => {
        fs.readFile(path, encoding, (err, fileContent) => {
            if (err) reject(err);
            else resolve(fileContent);
        });
    });
}

function deleteDir(path) {
    return exec(`rm -rf ${path}`);
}