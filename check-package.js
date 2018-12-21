const axios = require('axios');
const git = require('simple-git/promise');
const dayjs = require('dayjs');
const uuid = require('uuid/v4');
const fs = require('graceful-fs');
const crypto = require('crypto');
const diff = require('diff');
const path = require('path');
const _exec = require('child_process').exec;
const package = require('./test.json');
const Repository = require('github-api/dist/components/Repository');
const Issue = require('github-api/dist/components/Issue');

const { WEBHOOK_TOKEN, GITHUB_TOKEN, TRAVIS_BUILD_ID } = process.env;
const repo = new Repository('ISNIT0/safe-npm-packages', {
    token: GITHUB_TOKEN
});
const issue = new Issue('ISNIT0/safe-npm-packages', { token: GITHUB_TOKEN });

const testDateTime = dayjs().format('DD-MM-YYYY__HH_mm');

const reportDirectory = `${package.packageName}/${package.version}/${testDateTime}.md`;


const reportTemplate = ({ grade, message }) => {
    return `:robot: ${grade === 'F' ? ':rotating_light:' : ''}

| Field | Output |
|----|----|
| Grade | ${grade} |
| Tested At | ${new Date().toUTCString()} |
| Travis Build | [${TRAVIS_BUILD_ID}](https://travis-ci.org/ISNIT0/npm-package-tester/builds/${TRAVIS_BUILD_ID}) |
    
${message}
    `;
}

if (!('toJSON' in Error.prototype)) {
    // Hack to allow stringifying errors.
    // https://stackoverflow.com/questions/18391212/is-it-not-possible-to-stringify-an-error-using-json-stringify
    Object.defineProperty(Error.prototype, 'toJSON', {
        value: function () {
            var alt = {};

            Object.getOwnPropertyNames(this).forEach(function (key) {
                alt[key] = this[key];
            }, this);

            return alt;
        },
        configurable: true,
        writable: true
    });
}

doCheck(package)
    .then(async () => {
        console.log(`Package passed the check`);
        const reportContent = reportTemplate({
            grade: 'C',
            message: `
Package check passed on Travis.

[see more](https://travis-ci.org/ISNIT0/npm-package-tester/branches)
`
        }, null, '\t');
        await repo.writeFile('master', reportDirectory, reportContent, `:tada: Automatically applying 'C' grade`, {});

        await axios.get(`https://safenpm.herokuapp.com/report/update/${WEBHOOK_TOKEN}/${package.packageName}/${package.version}`);
    })
    .catch(async (diffs) => {
        console.error(`Package failed the check`, diffs)
        const reportContent = reportTemplate({
            grade: 'F',
            message: `Package check failed on Travis.

[see more](https://travis-ci.org/ISNIT0/npm-package-tester/branches)

\`\`\`
${JSON.stringify(diffs, null, '\t')}
\`\`\`
`
        }, null, '\t');
        try {
            await repo.writeFile('master', reportDirectory, reportContent, `:rotating_light: Automatically applying 'F' grade`, {});
        } catch (err) {
            console.error(`Failed to update file [${reportDirectory}]`);
            process.exit(1);
        }

        try {
            await axios.get(`https://safenpm.herokuapp.com/report/update/${WEBHOOK_TOKEN}/${package.packageName}/${package.version}`);
        } catch (err) {
            console.error(`Failed to call webhook`);
            process.exit(1)
        }
        const backTicks = '```';
        try {
            await issue.createIssue({
                title: `Please verify auto check for [${package.packageName}@${package.version}]`,
                body: `## :robot: Failed to verify package [${package.packageName}@${package.version}]

Check the report here: [${reportDirectory}](${reportDirectory})

${backTicks}
${JSON.stringify(diffs, null, '\t')}
${backTicks}
`,
                assignees: ['ISNIT0'],
                labels: ['auto-fail']
            });
        } catch (err) {
            console.error(`Failed to create GitHub issue`);
            process.exit(1)
        }
    })
    .catch(err => {
        console.error(`Died with:`, err);
        process.exit(1);
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
            throw validDiffs;
        }

    } catch (diffs) {
        console.error(`Error verifying [${packageName}], diffs:`, diffs);
        throw diffs;
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