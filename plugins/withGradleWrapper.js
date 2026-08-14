const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

module.exports = function withGradleWrapper(config, props = {}) {
  const gradleVersion = props.gradleVersion || '9.4.1';
  return withDangerousMod(config, [
    'android',
    async (config) => {
      const gradleWrapperPath = path.join(
        config.modRequest.platformProjectRoot,
        'gradle',
        'wrapper',
        'gradle-wrapper.properties'
      );
      if (fs.existsSync(gradleWrapperPath)) {
        let content = fs.readFileSync(gradleWrapperPath, 'utf8');
        content = content.replace(
          /distributionUrl=.*/g,
          `distributionUrl=https\\://services.gradle.org/distributions/gradle-${gradleVersion}-bin.zip`
        );
        fs.writeFileSync(gradleWrapperPath, content, 'utf8');
      }
      return config;
    },
  ]);
};
