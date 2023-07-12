async ({ deep, require, gql, data: { triggeredByLinkId, newLink } }) => {
  const fs = await deep.import('fs');
  const encoding = 'utf8';
  const deepPackageKeyWord = 'deep-package';
  
  const makeTempDirectory = async () => {
    const os = await deep.import('os');
    const { v4: uuid } = await deep.import('uuid');
    
    const baseTempDirectory = os.tmpdir();
    const randomId = uuid();
    const tempDirectory = [baseTempDirectory,randomId].join('/');
    fs.mkdirSync(tempDirectory);
    console.log(tempDirectory);
    return tempDirectory;
  };
  const npmInstall = async (packageName, installationPath) => {
    const execSync = (await deep.import('child_process')).execSync;
  
    const command = `npm --prefix "${installationPath}" i ${packageName}`;
    try {
      const output = execSync(command, { 
        encoding: 'utf-8',
        cwd: installationPath
      }).toString();
      console.log(`${command}\n`, output);
      return {
        resolved: {
          status: 0,
          stdout: output
        }
      };
    } catch(error) {
      return {
        rejected: error
      };
    }
  };
  const npmLogin = async (token, tempDirectory) => {
    const execSync = (await deep.import('child_process')).execSync;
  
    const command = `npm set "//registry.npmjs.org/:_authToken" ${token}`;
    const output = execSync(command, { 
        encoding: 'utf-8',
        cwd: tempDirectory
    });
    console.log(`${command}\n`, output);
    return output;
  };
  const npmPublish = async (tempDirectory) => {
    const execSync = (await deep.import('child_process')).execSync;
  
    const command = `npm publish --access public`;
    const output = execSync(command, { 
        encoding: 'utf-8',
        cwd: tempDirectory
    });
    console.log(`${command}\n`, output);
    return output;
  };
  const makeDeepPackagePath = (tempDirectory, packageName) => [tempDirectory, 'node_modules', packageName].join('/');
  const makeDeepJsonPath = (packagePath) => [packagePath, 'deep.json'].join('/');
  const makePackageJsonPath = (packagePath) => [packagePath, 'package.json'].join('/');
  const deepExport = async (packageId) => {
    const packager = new (await deep.import('@deep-foundation/deeplinks/imports/packager')).Packager(deep);
    const exported = await packager.export({ packageLinkId: packageId });
    console.log(exported);
    if (exported?.errors?.length) throw exported;
    return exported;
  };
  const loadNpmToken = async () => {
    const containTreeId = await deep.id('@deep-foundation/core', 'containTree');
    const tokenTypeId = await deep.id('@deep-foundation/npm-packager', 'Token');
    const { data: [{ value: { value: npmToken = undefined } = {}} = {}] = []} = await deep.select({
      up: {
        tree_id: { _eq: containTreeId },
        parent: { id: { _eq: triggeredByLinkId } },
        link: { type_id: { _eq: tokenTypeId } }
      }
    });
    return npmToken;
  };
  const updateVersion = async (packageJsonPath, packageId, localVersion) => {
    const semver = await deep.import('semver');

    const packageJson = fs.readFileSync(packageJsonPath, { encoding });
    if (!packageJson) {
      throw 'package.json is not found in installed package';
    }
    const npmPackage = JSON.parse(packageJson);
    const npmVersion = npmPackage?.version || '0.0.0';

    const nextVersion = semver.gt(localVersion, npmVersion) ? localVersion : semver.inc(npmVersion, 'patch');
    npmPackage.version = nextVersion;

    // TODO: Not sure about this.
    // TODO: Should we update the version inside deep?
    // TODO: May be we would allow to user to set specific version 
    // TODO: if they like or only they can interpret changes in code?
    await deep.update({
      link: {
        type_id: { _eq: await deep.id('@deep-foundation/core', 'PackageVersion') },
        to_id: { _eq: packageId },
      },
    }, { value: nextVersion }, { table: 'strings' });
    fs.writeFileSync(packageJsonPath, JSON.stringify(npmPackage, null, 2), { encoding });
  };
  const addKeyword = (packageJsonPath, keyword) => {
    const packageJson = fs.readFileSync(packageJsonPath, { encoding });
    if (!packageJson) {
      throw 'package.json is not found in installed package';
    }
    const npmPackage = JSON.parse(packageJson);
    if (npmPackage?.keywords?.length > 0) {
      if (!npmPackage.keywords.includes(keyword)) {
        npmPackage.keywords.push(keyword); 
      }
    } else {
      npmPackage.keywords = [ keyword ];
    }
    fs.writeFileSync(packageJsonPath, JSON.stringify(npmPackage, null, 2), { encoding });
  };
  const installDependencies = async (packagePath, dependencies) => {
    for (const dependency of dependencies) {
      const packageName = `${dependency.name}@~${dependency.version}`;
      const installationResult = await npmInstall(packageName, packagePath);
      if (installationResult?.rejected) {
        throw installationResult.rejected;
      } else if (!installationResult?.resolved) {
        throw new Error('Unsupported NPM dependency installation result.');
      }
    }
  }

  const { data: [packageQuery] } = await deep.select({ id: newLink.to_id });
  const packageName = packageQuery?.value?.value;
  if (!packageName) {
    throw new Error('Package query value is empty.');
  }
  const packageVersionTypeId = await deep.id('@deep-foundation/core', 'PackageVersion');
  const { data: [{ versions: [{ version: { value: localVersion = undefined } = {}} = {}] = []} = {}] = []} = await deep.select({ id: newLink.from_id }, { returning: `id versions: in(where: { type_id: { _eq: ${packageVersionTypeId} } }) { id type_id version: value }` });
  if (!localVersion) {
    throw new Error('Package must have a version.');
  }

  const packageId = newLink.from_id;
  const { data: [{ value: actualPackageName }]} = await deep.select(
    { link_id: { _eq: packageId } },
    {
      table: 'strings',
      returning: 'value'
    }
  );
  if (packageName !== actualPackageName) {
    throw new Error('Package query value should be equal to actual package name.');
  }
  const tempDirectory = await makeTempDirectory();
  try {
    const npmToken = await loadNpmToken();
    if (!npmToken) {
      throw new Error('NPM token is required to publish package. NPM token should be contained by user that does insert publish link.');
    }
    await npmLogin(npmToken, tempDirectory);
    const installationResult = await npmInstall(packageName, tempDirectory);
    let deepPackagePath; 
    let packageJsonPath;
    if (installationResult?.resolved) {
      deepPackagePath = makeDeepPackagePath(tempDirectory, packageName);
      packageJsonPath = makePackageJsonPath(deepPackagePath);
    } else if(installationResult?.rejected) {
      deepPackagePath = tempDirectory;
      packageJsonPath = makePackageJsonPath(deepPackagePath);
      const packageJson = {
        name: packageName
      };
      fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2), encoding);
    } else {
      throw new Error('Unsupported NPM installation result.');
    }
    console.log('deepPackagePath', deepPackagePath);
    console.log('packageJsonPath', packageJsonPath);
    addKeyword(packageJsonPath, deepPackageKeyWord);
    await updateVersion(packageJsonPath, packageId, localVersion);
    const pkg = await deepExport(packageId);
    console.log(pkg);
    await installDependencies(deepPackagePath, pkg.dependencies);
    const deepJsonPath = makeDeepJsonPath(deepPackagePath);
    fs.writeFileSync(deepJsonPath, JSON.stringify(pkg, null, 2), encoding);
    await npmPublish(deepPackagePath);
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
}