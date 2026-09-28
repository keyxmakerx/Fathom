import licences from './licences.json';
import './about.css';

export interface AboutProps {
  onBack: () => void;
}

interface ShippedLibrary {
  name: string;
  version: string;
  license: string;
  copyright: string | null;
}

/**
 * The libraries the web app ships, each with its licence and copyright line
 * (ADR-0060 decision 12). `scripts/licences-npm.mjs --write` generates the list
 * from the lockfile, and CI fails when the two disagree.
 */
export function About({ onBack }: AboutProps) {
  const rows = licences as ShippedLibrary[];
  return (
    <section className="about" aria-labelledby="about-title">
      <div>
        <button type="button" className="home__btn home__btn--small" onClick={onBack}>
          Back
        </button>
      </div>
      <h1 id="about-title" className="about__title">
        About Fathom
      </h1>
      <p className="about__lede">
        The web app is built on these open-source libraries. Each one is free to use, in a business too, under the
        licence named beside it.
      </p>
      <table className="about__table">
        <thead>
          <tr>
            <th scope="col">Library</th>
            <th scope="col">Version</th>
            <th scope="col">Licence</th>
            <th scope="col">Copyright</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((lib) => (
            <tr key={`${lib.name}@${lib.version}`}>
              <td>{lib.name}</td>
              <td className="about__num">{lib.version}</td>
              <td>{lib.license}</td>
              <td className="about__muted">{lib.copyright ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
