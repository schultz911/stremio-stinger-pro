const { parseMediaStingerSeoText } = require('../src/scrapers/mediastinger');

describe('parseMediaStingerSeoText', () => {
    it('handles empty input gracefully', () => {
        const result = parseMediaStingerSeoText('');
        expect(result).toEqual({
            seoMid: false,
            seoPost: false,
            seoBloopers: false,
            seoNo: false,
            noStinger: false
        });
    });

    it('handles null/undefined gracefully', () => {
        const result = parseMediaStingerSeoText(null);
        expect(result).toEqual({
            seoMid: false,
            seoPost: false,
            seoBloopers: false,
            seoNo: false,
            noStinger: false
        });
    });

    it('detects seoNo correctly without stinger', () => {
        const result = parseMediaStingerSeoText('there are no extra scenes');
        expect(result).toEqual({
            seoMid: false,
            seoPost: false,
            seoBloopers: false,
            seoNo: true,
            noStinger: true
        });
    });

    it('detects seoNo correctly with zero', () => {
        const result = parseMediaStingerSeoText('zero extras');
        expect(result).toEqual({
            seoMid: false,
            seoPost: false,
            seoBloopers: false,
            seoNo: true,
            noStinger: true
        });
    });

    it('detects mid negative correctly', () => {
        const result = parseMediaStingerSeoText('no scenes during the credits');
        expect(result).toEqual({
            seoMid: 'false',
            seoPost: false,
            seoBloopers: false,
            seoNo: true,
            noStinger: false
        });
    });

    it('detects post negative correctly', () => {
        const result = parseMediaStingerSeoText('no scenes after the credits');
        expect(result).toEqual({
            seoMid: false,
            seoPost: 'false',
            seoBloopers: false,
            seoNo: true,
            noStinger: false
        });
    });

    it('detects both negative correctly', () => {
        const result = parseMediaStingerSeoText('no scenes during or after the credits');
        expect(result).toEqual({
            seoMid: 'false',
            seoPost: 'false',
            seoBloopers: false,
            seoNo: true,
            noStinger: false
        });
    });

    it('detects mid positive correctly', () => {
        const result = parseMediaStingerSeoText('there is a scene during the credits');
        expect(result).toEqual({
            seoMid: true,
            seoPost: false,
            seoBloopers: false,
            seoNo: false,
            noStinger: false
        });
    });

    it('detects post positive correctly', () => {
        const result = parseMediaStingerSeoText('there is a scene after the credits');
        expect(result).toEqual({
            seoMid: false,
            seoPost: true,
            seoBloopers: false,
            seoNo: false,
            noStinger: false
        });
    });

    it('detects bloopers correctly', () => {
        const result = parseMediaStingerSeoText('there are bloopers and outtakes');
        expect(result).toEqual({
            seoMid: false,
            seoPost: false,
            seoBloopers: true,
            seoNo: false,
            noStinger: false
        });
    });

    it('detects mid negative correctly using mid keyword', () => {
        const result = parseMediaStingerSeoText('no scenes mid credits');
        expect(result).toEqual({
            seoMid: 'false',
            seoPost: false,
            seoBloopers: false,
            seoNo: true,
            noStinger: false
        });
    });

    it('detects post negative correctly using post keyword', () => {
        const result = parseMediaStingerSeoText('no scenes post credits');
        expect(result).toEqual({
            seoMid: false,
            seoPost: 'false',
            seoBloopers: false,
            seoNo: true,
            noStinger: false
        });
    });

    it('detects mid positive correctly using mid keyword', () => {
        const result = parseMediaStingerSeoText('there is a scene mid credits');
        expect(result).toEqual({
            seoMid: true,
            seoPost: false,
            seoBloopers: false,
            seoNo: false,
            noStinger: false
        });
    });

    it('detects post positive correctly using post keyword', () => {
        const result = parseMediaStingerSeoText('there is a scene post credits');
        expect(result).toEqual({
            seoMid: false,
            seoPost: true,
            seoBloopers: false,
            seoNo: false,
            noStinger: false
        });
    });

    it('detects bloopers correctly using outtake keyword', () => {
        const result = parseMediaStingerSeoText('there are outtakes');
        expect(result).toEqual({
            seoMid: false,
            seoPost: false,
            seoBloopers: true,
            seoNo: false,
            noStinger: false
        });
    });

});
