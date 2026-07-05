const manifestHandler = (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.json({
        id: 'org.stinger.pro',
        version: '3.1.0',
        name: 'Stremio Stinger Pro',
        description:
            'Instantly detect mid/post-credits scenes, outtakes, sequel setups, and extended franchise metadata (prequels, sequels, source material) in Stremio. Powered by AfterCredits, TMDb, and Wikipedia.',
        logo: 'https://raw.githubusercontent.com/schultz911/stremio-stinger-pro/main/public/icon.png?v=3.1.0',
        types: ['movie'],
        catalogs: [],
        resources: ['stream'],
        idPrefixes: ['tt'],
        behaviorHints: { configurable: true, configurationRequired: false },
    });
};

module.exports = { manifestHandler };
